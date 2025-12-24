# ScriptFlow - UserScript Manager

## If I couldn't tell from the text above, what is ScriptFlow?

ScriptFlow is a userscript manager alternative for people who prefer userscript managers more or less built as a development suite for developers and people who work with large projects, including features such as:
* Folders
* Importing
* Editing environments
* & Web injection across any site

---

## Index

- [Installation](#installation)
- [How it works](#how-it-works)
- [Browser Support](#browser-support)
- [Core Features](#core-features)
  - [Multi-File Example](#multi-file-example)
  - [Live Editing & Local Workspaces](#live-editing--local-workspaces)  
  - [Monaco Editor](#monaco-editor)
  - [Git Integration](#git-integration)
  - [GM/Greasemonkey API](#gmgreasemonkey-api)
  - [Developer Tools](#developer-tools)
  - [Import & Export](#import--export)
  - [Live Preview (PiP)](#live-preview-pip)
  - [Execution Control](#execution-control)
  - [Personalization](#personalization)
  - [Templates](#templates)
- [About "Allow User Scripts"](#about-allow-user-scripts)
- [Screenshots](#screenshot-showcase)
- [Support Development](#support-development)

---

## Installation

1. Clone or download as ZIP

![alt text](https://i.imgur.com/8TdFbys.png)

2. Open `chrome://extensions`
3. Enable **Developer Mode**
4. Click **Load Unpacked** → select ScriptFlow folder inside of the unzipped folder
5. **Enable "Allow User Scripts"** (Scriptflow wont work as intended without this enabled)

---

## How it works

ScriptFlow, as previously mentioned in the first category, is primarily aimed as a userscript manager/development suite.

For editing files within ScriptFlow, you may notice the metadata block format is different from other userscript managers as following:

<details>
<summary>Expand to view</summary>

Scriptflow:
```js
/*
@ScriptFlow
{
  "name": "New Script",
  "description": "A brief description of your script",
  "match": [
    "https://example.com/*"
  ]
}
*/

(function() {
    'use strict';
    
    console.log('ScriptFlow script loaded!');
    
})();
```

Tampermonkey:
```js
// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2025-12-24
// @description  try to take over the world!
// @author       You
// @match        https://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log("Hello World")
})();
```
</details>

This is done intentionally, for both readability and just being easier to use.

Using @match as an example, commonly used in Tampermonkey and ViolentMonkey, it goes from:

```js
// @match        https://*/*
```

To:

```js
  "match": ["all"]
```

Which is both a 10 character difference and also more versatile, allowing you to do "all" rather than having to do `*://*/*`.

---

## Browser Support

| ✅ Supported | ❌ Unsupported |
|----------|-----------------|
| Chrome (v120+) | Firefox |
| Edge | Safari |
| Brave | |
| Opera | |
| Arc | |
| Vivaldi | |

ScriptFlow uses Chrome's `userScripts` API. Firefox and Safari don't have it.

---

## Core Features

### Multi-File Projects

| Feature | Support |
|---------|---------|
| ES Modules (`import`/`export`) | ✅ |
| CommonJS (`require`/`module.exports`) | ✅ |
| JSON imports | ✅ |
| CSS auto-injection | ✅ |
| Relative paths (`./`, `../`) | ✅ |
| Entry point configuration | ✅ |
| Circular dependency detection | ✅ |
| `require.context()` | ✅ |
| Lazy module loading | ✅ |

---

### Multi-file Example

```js
// main.js
import { greet } from './greet.js';
import config from './config.json';

greet(config.name);
```

```js
// greet.js
export function greet(name) {
  console.log('Hello', name);
}
```

---

### Live Editing & Local Workspaces

Uses the **File System Access API**

* Load any local folder as a workspace
* Changes sync automatically
* Permission persists across sessions
* Create/rename/delete files in the explorer

When saving a file, It will also automatically update the script as well, so you dont need to both save the file and save the script

---

### Monaco Editor

| Currently supported for the Editor | |
|---------|--|
| Syntax highlighting | ✅ |
| Autocomplete & IntelliSense | ✅ |
| Code formatting (Ctrl+H) | ✅ |
| Command palette (Ctrl+[) | ✅ |
| File explorer sidebar (Ctrl+B) | ✅ |
| Multiple themes | Dracula, Monokai, VS Dark, VS Light, Solarized |
| Configurable font size | 10-30px |
| Tab size | 2-8 spaces |
| Line numbers | On, Off, Relative |
| Minimap | Toggle on/off |
| Word wrap | Toggle on/off |
| Large file handling | Optimized for files >200KB |

---

### Git Integration

To make the experience better, ScriptFlow also has intergration with Github, allowing you to do the following without having to leave the workspace:

* Clone repositories
* Pull/push changes
* Select branches
* View Repository history (quick access to recent repos)
* GitHub PAT authentication
* Push your local workspace to new repo

Uses `isomorphic-git`

---

### GM/Greasemonkey API

Fully compatible with the following standard userscript APIs:

| API | Description |
|-----|-------------|
| `GM_addStyle(css)` | Inject CSS into pages |
| `GM_setValue(key, value)` | Persistent storage |
| `GM_getValue(key, default)` | Read from storage |
| `GM_deleteValue(key)` | Delete stored value |
| `GM_listValues()` | List all stored keys |
| `GM_xmlhttpRequest(details)` | Cross-origin requests |
| `GM_getResourceText(name)` | Access embedded resources |
| `GM_openInTab(url)` | Open URLs in new tabs |
| `GM_setClipboard(text)` | Copy to clipboard |
| `GM_setHTML(el, html)` | Safe innerHTML (Trusted Types) |
| `GM_info` | Script metadata |
| `GM_log(msg)` | Styled console logging |
| `unsafeWindow` | Direct page window access |


---

### Developer Tools

| Tool | Description |
|------|-------------|
| **JavaScript Console** | Allows for code execution on any tab from the extension |
| **Memory Inspector** | Draggable overlay showing live memory usage |
| **Debug Logging** | Toggles detailed console outputting |
| **Time Tracking** | Tracks time spent editing each script |

---

### Import & Export

| Feature | |
|---------|--|
| Export project as ZIP | ✅ |
| Export all data (JSON backup) | ✅ |
| Import from JSON backup | ✅ |
| **Import Tampermonkey/Violentmonkey backups** | ✅ (ZIP with .user.js files) |
| **Install from URL** | Click any `.user.js` link to install |
| **Export as bundled userscript** | Single-file with proper headers |

---

### Live Preview (PiP)

Opens a Picture-in-Picture window which:

* Loads your HTML/CSS/JS together
* Resolves imports the same way
* Updates instantly when you save

> ⚠️ Do note this is not a full browser environment, which means there is no site JS or extensions.

---

### Execution Control

| Setting | Options |
|---------|---------|
| Run At | `document_start`, `document_end`, `document_idle` |
| URL patterns | `https://*.example.com/*` |
| Exclude patterns | Skip specific URLs |
| Execution delay | Customizable 0-5000ms delay before running |
| Manual run | Execute from popup |
| Auto-update check | Never, Daily, Weekly, Monthly |

---


### Personalization

* Upload custom background images (PNG, JPG, GIF up to 10MB)
* Adjust opacity and blur
* Multiple UI themes (Dark Purple, Dark Blue, Dark Forest, Midnight, Amber)

---

### Templates

* **Basic Script** — Minimal structure
* **DOM Manipulation** — Ready for DOM mods
* **AJAX Interceptor** — Fetch/XHR interception
* **CSS Injection** — Ad-blocking and styling
* **Utility Functions** — Helpers like `waitForElement()`

---


## About "Allow User Scripts"

When you enable ScriptFlow, Chrome warns you:

> "This extension can run code that hasn't been reviewed by Google"

This is **expected**.

**Why?**
- ScriptFlow uses the `userScripts` API (same as Tampermonkey)
- You're writing code that runs on websites
- Chrome warns because it's powerful

**Is it safe?**
- Code is open source (check it yourself)
- No minification or obfuscation
- No telemetry or tracking
- No external requests unless you add them

---

## Screenshot Showcase

### Project Structure
![Project structure](https://i.ibb.co/23D83vjj/scriptflow4.png)

### Monaco Editor
![Monaco editor](https://i.ibb.co/VYvqNJJQ/scriptflow3.webp)

### Live Preview (PiP)
![Live Preview](https://i.ibb.co/xq646kPK/y281nkoz.webp)

### Git Integration
![Git integration](https://i.ibb.co/Lh10q6pf/scriptflow5.png)
![Source Control](https://i.ibb.co/Jjc4zb4L/2fmp992i.webp)

### Personalization
![Personalization](https://i.ibb.co/hF8kWJ2N/image.webp)

---

## Support Development

If ScriptFlow makes your life easier, consider buying me a coffee!

> ScriptFlow will **always** remain free and open source.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/kusoi)

Your support helps me:
- Build new features
- Fix bugs faster
- Keep it free and open source

---

**Author:** Kusoi

**Discord Server:** https://discord.com/invite/gwC7KW3j7v

---
