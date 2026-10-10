# Recover an installed Chrome extension on Windows

You do not need the original ZIP if the old extension is still installed.

## Store-installed / normally installed extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Copy the old compressor extension's **ID**.
4. In File Explorer open:

   `%LOCALAPPDATA%\Google\Chrome\User Data`

5. Open your profile (`Default`, `Profile 1`, `Profile 2`, etc.).
6. Open:

   `Extensions\<EXTENSION-ID>\`

7. Open the newest version-number folder and **copy that whole folder somewhere safe before editing it**.

You can also run the included `recover-installed-extension.ps1` and give it the extension ID. It searches Chrome profiles and copies the newest matching installed version to your Desktop.

## If the old extension was loaded with “Load unpacked”

Chrome uses the original folder you selected; it may not exist in Chrome's normal `Extensions` directory. On `chrome://extensions`, copy its ID and search your computer for the original folder / `manifest.json`. Make a backup before changing anything.
