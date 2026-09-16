// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16. WASAPI PCM + QPC packet timestamps.
// API contract: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

namespace WboAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDevices {
        void EnumAudioEndpoints(int flow, uint state, out IDeviceCollection devices);
        void GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-C0A2D71A0C8F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDeviceCollection { void GetCount(out uint count); void Item(uint index, out IDevice device); }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDevice {
        void Activate(ref Guid iid, uint context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        void OpenPropertyStore(uint access, out IPropertyStore properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out uint state);
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid id; public uint key; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count); void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, IntPtr value);
    }
    [StructLayout(LayoutKind.Sequential, Pack = 2)] struct WaveFormat {
        public ushort format, channels; public uint rate, bytesPerSecond;
        public ushort blockAlign, bits, extra;
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient {
        void Initialize(int share, uint flags, long duration, long period, ref WaveFormat format, IntPtr session);
        void GetBufferSize(out uint frames); void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int share, ref WaveFormat format, out IntPtr closest);
        void GetMixFormat(out IntPtr format); void GetDevicePeriod(out long normal, out long minimum);
        void Start(); void Stop(); void Reset(); void SetEventHandle(IntPtr handle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICaptureClient {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpc);
        void ReleaseBuffer(uint frames); void GetNextPacketSize(out uint frames);
    }
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivation {
        void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object client);
    }
    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICompletion { void ActivateCompleted(IActivation operation); }
    [ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgile {}
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class Completion : ICompletion, IAgile {
        internal readonly ManualResetEvent Ready = new ManualResetEvent(false);
        internal object Client; internal Exception Error;
        public void ActivateCompleted(IActivation operation) {
            try { int result; operation.GetActivateResult(out result, out Client); Marshal.ThrowExceptionForHR(result); }
            catch (Exception error) { Error = error; }
            finally { Ready.Set(); }
        }
    }
    public static class Capture {
        [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(string path, ref Guid iid, IntPtr parameters,
            ICompletion callback, out IActivation operation);
        [DllImport("ole32.dll")] static extern int PropVariantClear(IntPtr value);
        [DllImport("ntdll.dll")] static extern int RtlGetVersion(ref VersionInfo info);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct VersionInfo {
            public uint size, major, minor, build, platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string service;
        }
        static string Json(string value) {
            StringBuilder result = new StringBuilder("\"");
            foreach (char c in value) {
                if (c < 32) result.Append("\\u" + ((int)c).ToString("x4"));
                else if (c == '\\' || c == '"') { result.Append('\\'); result.Append(c); }
                else result.Append(c);
            }
            return result.Append('"').ToString();
        }
        public static void List() {
            Console.OutputEncoding = new UTF8Encoding(false);
            IDevices devices = (IDevices)new Enumerator(); IDeviceCollection collection;
            devices.EnumAudioEndpoints(1, 1, out collection); uint count; collection.GetCount(out count);
            Console.WriteLine("{\"sources\":[{\"id\":\"default\",\"name\":\"Default microphone\"}");
            for (uint i = 0; i < count; i++) {
                IDevice device; collection.Item(i, out device); string id; device.GetId(out id);
                string name = id; IPropertyStore properties; device.OpenPropertyStore(0, out properties);
                IntPtr value = Marshal.AllocCoTaskMem(24);
                try {
                    PropertyKey key = new PropertyKey { id = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), key = 14 };
                    for (int j = 0; j < 24; j++) Marshal.WriteByte(value, j, 0);
                    properties.GetValue(ref key, value);
                    if (Marshal.ReadInt16(value) == 31) name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(value, 8));
                } finally { PropVariantClear(value); Marshal.FreeCoTaskMem(value); }
                Console.WriteLine(",{\"id\":" + Json(id) + ",\"name\":" + Json(name) + "}");
            }
            Console.WriteLine("],\"processes\":["); bool first = true;
            foreach (Process process in Process.GetProcesses()) {
                try {
                    if (process.Id == Process.GetCurrentProcess().Id || process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                    Console.WriteLine((first ? "" : ",") + "{\"id\":" + process.Id + ",\"name\":" + Json(process.ProcessName) + "}"); first = false;
                } catch (InvalidOperationException) {} catch (System.ComponentModel.Win32Exception) {}
                finally { process.Dispose(); }
            }
            Console.WriteLine("]}");
        }
        static IAudioClient Activate(string mode, string target) {
            Guid iid = typeof(IAudioClient).GUID;
            if (mode == "source") {
                IDevices devices = (IDevices)new Enumerator(); IDevice device;
                if (target == "default") devices.GetDefaultAudioEndpoint(1, 1, out device);
                else devices.GetDevice(target, out device);
                object client; device.Activate(ref iid, 23, IntPtr.Zero, out client); return (IAudioClient)client;
            }
            if (mode != "process") throw new ArgumentException("Unknown capture mode");
            VersionInfo version = new VersionInfo(); version.size = (uint)Marshal.SizeOf(version); RtlGetVersion(ref version);
            if (version.build < 20348) throw new NotSupportedException("Process loopback requires Windows build 20348 or newer (Windows 11 supported).");
            uint pid = UInt32.Parse(target); if (pid == 0) throw new ArgumentException("Invalid process ID");
            IntPtr data = Marshal.AllocCoTaskMem(12), variant = Marshal.AllocCoTaskMem(24);
            Completion callback = new Completion(); IActivation operation = null;
            try {
                for (int i = 0; i < 24; i++) Marshal.WriteByte(variant, i, 0);
                Marshal.WriteInt32(data, 0, 1); Marshal.WriteInt32(data, 4, checked((int)pid)); Marshal.WriteInt32(data, 8, 0);
                Marshal.WriteInt16(variant, 65); Marshal.WriteInt32(variant, 8, 12);
                Marshal.WriteIntPtr(variant, IntPtr.Size == 8 ? 16 : 12, data);
                ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, variant, callback, out operation);
                if (!callback.Ready.WaitOne(15000)) throw new TimeoutException("WASAPI activation timed out");
                if (callback.Error != null) throw callback.Error;
                return (IAudioClient)callback.Client;
            } finally {
                // A timed-out async operation can still reference its activation parameters.
                if (callback.Ready.WaitOne(0)) { Marshal.FreeCoTaskMem(data); Marshal.FreeCoTaskMem(variant); }
                GC.KeepAlive(operation); GC.KeepAlive(callback);
            }
        }
        public static void Run(string mode, string target) {
            IAudioClient client = Activate(mode, target);
            WaveFormat format = new WaveFormat { format = 1, channels = 2, rate = 48000, bytesPerSecond = 192000, blockAlign = 4, bits = 16, extra = 0 };
            uint flags = 0x80000000u | 0x08000000u | 0x00040000u; // convert PCM, quality, event callback
            if (mode == "process") flags |= 0x00020000u;
            client.Initialize(0, flags, 0, 0, ref format, IntPtr.Zero);
            Guid iid = typeof(ICaptureClient).GUID; object service; client.GetService(ref iid, out service);
            ICaptureClient capture = (ICaptureClient)service;
            using (AutoResetEvent available = new AutoResetEvent(false))
            using (ManualResetEvent stop = new ManualResetEvent(false))
            using (BinaryWriter output = new BinaryWriter(Console.OpenStandardOutput())) {
                client.SetEventHandle(available.SafeWaitHandle.DangerousGetHandle());
                Thread quit = new Thread(delegate() {
                    Console.ReadLine();
                    try { stop.Set(); } catch (ObjectDisposedException) {}
                }); quit.IsBackground = true; quit.Start();
                client.Start();
                try {
                    while (WaitHandle.WaitAny(new WaitHandle[] { stop, available }, 1000) != 0) {
                        uint pending; capture.GetNextPacketSize(out pending);
                        while (pending > 0) {
                            IntPtr data; uint frames, status; ulong position, qpc;
                            capture.GetBuffer(out data, out frames, out status, out position, out qpc);
                            try {
                                byte[] pcm = new byte[checked((int)frames * 4)];
                                if ((status & 2) == 0) Marshal.Copy(data, pcm, 0, pcm.Length);
                                if ((status & 4) != 0) throw new IOException("WASAPI reported an invalid capture timestamp");
                                output.Write(new byte[] { 87, 66, 79, 65 }); output.Write(frames); output.Write(checked(qpc * 100));
                                output.Write(pcm); output.Flush();
                            } finally { capture.ReleaseBuffer(frames); }
                            capture.GetNextPacketSize(out pending);
                        }
                    }
                } finally { client.Stop(); }
            }
        }
    }
}
