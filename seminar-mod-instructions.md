Add the following features to this project. Also make a CLI program in Python that should interact with these new features according to my specifications, which will be referred to as the helper program. "Moderator" refers to a board moderator. 

Don't add them all at once. Only add the ones that I asked you to add: 

<!-- 1. Allow exporting the contents of a whiteboard in the internal formats of WBO (instead of SVG only), and allow such an exported file to be reimported. The exported file should be compressed.  -->

<!-- 1. I don't like how authentication is currently implemented. The user token `wbo-user-secret-v1` cookie may be transmitted unencrypted on a HTTP connection, and may be stored unencrypted on an untrusted host. Add a parallel authentication process by storing user cookies `wbo-user-secret-v2-private` and `wbo-user-secret-v2-public`, an Ed25519 keypair. 

   When the server starts, an environmental variable `WBO_BOARD_MODERATORS='<board_name>:<value>'` or an identical way to configure moderators should grant moderator permissions for board `<board_name>` for a user holding secret `<value>`:

   - If `<value>` is 32 hex chars, then it is a v1 secret value, and the server should authenticate using the old method; 
   - If `<value>` is 64 hex chars, then it is a v2 secret value. You should interpret it as a 32-byte Ed25519 public key. The server should perform authentication by sending a random string to client, and expect the client to return the signature of this string using `wbo-user-secret-v2-private`, which should be the matching private key of this public key. 

   When multiple moderator secrets are provided for a single board, the server should grant moderator permissions to any user holding a v1 token matching any v1 token given, or any user holding a private key matching any public key given.  -->

<!-- 1. Allow users to set their names when entering a board, either through a URL parameter, or as an input box on the homepage. If the user first enter a board without a name, they should be prompted for a name that defaults to the old generated name. The names for a user that is used for each board should be stored in a Cookie, which can be used when the user logs into the same board a second time without a name set. A user can always modify their own name in the web UI, and a moderator can modify the names of everyone.  -->
  
2. The moderator can modify a setting (in some interface) that divides the canvas into chunks of a specified size. Everyone can turn on a setting that locks their perspective to be centered on the last modified chunk (with margins to be configured by the moderator). The moderator can modify and lock this setting for everyone else. 

3. The moderator can modify the background color of the board. 
  
4. The server will record the start and end timestamp of each stroke and every other kind of modification in some kind of log file. The log file between a certain time interval may be downloaded in an moderator session via the helper program. 

5. The helper program can be configured to capture the voice input from the machine's microphone and a selected set of processes (intended to be a meeting software, so that the voices of both the speaker and the participants of a seminar can be recorded). It should automatically mark the recorded voice with timestamps, and also sync time with the server so that the server timestamp and client timestamp can reasonably match. 

   The helper program should include parameters to include a downloaded log file and a saved recording (with time syncing metadatas), and combine them to a video faithfully reflecting the whiteboard and the voice in the seminar. (`ffmpeg` should be assumed to be available on path, or be specified via a path in some argument.) 
  
   - A stroke should be assumed to be drawn with equal speed between its start and finish timestamp. 
   - The PoV of the video should snap to the last modified chunk (with margins configured via some command line argument). Some other ways to configure the PoV that you find useful should also be added, and configurable through CLA. 

6. Customizable keyboard controls through a button on the web UI, with two presets - one for the current keyboard controls, and one for an alternative control set that would be more familiar to some users with Shift+Scroll being scaling canvas, and Scroll just being vertical movement. 

Keep in mind that this project is AGPL-3.0, so as you add these feature, you should state the modifications in `README.md` and do other modifications to comply to the license requirements. 

Whenever you add a feature, you should perform the necessary tests. You should also at least add English and Simplified/Traditional Chinese localizations for strings added. 