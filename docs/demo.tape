# Record the README GIF with https://github.com/charmbracelet/vhs
#   export TYPESAFE_API_KEY=...
#   vhs docs/demo.tape
Output docs/demo.gif
Set FontSize 15
Set Width 1200
Set Height 900
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "npx agent-lighthouse examples/support-agent"
Sleep 400ms
Enter
Sleep 4s
Type "clear && npx agent-lighthouse examples/support-agent-fixed"
Enter
Sleep 4s
