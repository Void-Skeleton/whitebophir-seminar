Add the following features to this project. Also make a CLI program in Python that should interact with these new features according to my specifications, which will be referred to as the helper program. "Moderator" refers to a board moderator. 

Don't add them all at once. Only add the ones that I asked you to add: 

<!-- 1. Allow exporting the contents of a whiteboard in the internal formats of WBO (instead of SVG only), and allow such an exported file to be reimported. The exported file should be compressed.  -->

2. Allow users to set their names when entering a board, either through a URL parameter, or as an input box on the homepage. 
  
3. The moderator can modify a setting (in some interface) that divides the canvas into chunks of a specified size. Everyone can turn on a setting that locks their perspective to be centered on the last modified chunk (with margins to be configured by the moderator). The moderator can modify and lock this setting for everyone else. 

4. The moderator can modify the background color of the board. 
  
5. The server will record the start and end timestamp of each stroke and every other kind of modification in some kind of log file. The log file between a certain time interval may be downloaded in an moderator session via the helper program. 

6. The helper program can be configured to capture the voice input from the machine's microphone and a selected set of processes (intended to be a meeting software, so that the voices of both the speaker and the participants of a seminar can be recorded). It should automatically mark the recorded voice with timestamps, and also sync time with the server so that the server timestamp and client timestamp can reasonably match. 

   The helper program should include parameters to include a downloaded log file and a saved recording (with time syncing metadatas), and combine them to a video faithfully reflecting the whiteboard and the voice in the seminar. (`ffmpeg` should be assumed to be available on path, or be specified via a path in some argument.) 
  
   - A stroke should be assumed to be drawn with equal speed between its start and finish timestamp. 
   - The PoV of the video should snap to the last modified chunk (with margins configured via some command line argument). Some other ways to configure the PoV that you find useful should also be added, and configurable through CLA. 

Keep in mind that this project is AGPL-3.0, so as you add these feature, you should state the modifications in `README.md` and do other modifications to comply to the license requirements. 

Whenever you add a feature, you should perform the necessary tests. You should also at least add English and Simplified/Traditional Chinese localizations for strings added. 