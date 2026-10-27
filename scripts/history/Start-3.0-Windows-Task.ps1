# Historical scheduled-task entry used under the logged-in Acer user.
$ErrorActionPreference='Stop'
$root='E:\xxm\file-bridge-single\dev'
& 'C:\Program Files\nodejs\node.exe' ($root+'\source\host\supervisor.cjs') --profile-dir ($root+'\var')
exit $LASTEXITCODE
