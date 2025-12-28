// services/LanguageService.js
export function SetupSmartImports(editor) {
    monaco.languages.registerInlineCompletionsProvider('javascript', {
        async provideInlineCompletions(model, position, context, token) {
            const lineText = model.getLineContent(position.lineNumber);
            const textUntilPos = lineText.slice(0, position.column);

            const fnMatch = textUntilPos.match(/import\s+(?:\{([^}]+?)\s*\}|\s*([\w$]+))\s+from\s*$/i);
            if (!fnMatch) return {
                items: []
            };

            let symbolName;
            if (fnMatch[1]) {
                const firstName = fnMatch[1].trim().split(/\s*,\s*/)[0];
                symbolName = firstName.split(/\s+as\s+/i)[0].trim();
            } else if (fnMatch[2]) {
                symbolName = fnMatch[2].trim();
            }
            const matches = await FindFilesExporting(symbolName, editor);

            if (!matches || matches.length === 0) return {
                items: []
            };

            const chosenPath = matches[0];
            const rel = getRelativeImportPath(editor, chosenPath);

            const hasQuote = /['"]$/.test(textUntilPos);
            const insertText = hasQuote ? rel + '"' : `"${rel}"`;

            return {
                items: [{
                    insertText: insertText,
                    range: new monaco.Range(
                        position.lineNumber,
                        position.column,
                        position.lineNumber,
                        position.column
                    )
                }]
            };
        },
        freeInlineCompletions() {}
    });

    monaco.languages.registerCompletionItemProvider('javascript', {
        triggerCharacters: [' ', '"', "'", '/'],
        provideCompletionItems: async (model, position) => {
            const lineText = model.getLineContent(position.lineNumber);
            const textUntilPos = lineText.slice(0, position.column);

            const fnMatch = textUntilPos.match(/import\s+(?:\{([^}]+?)\s*\}|([\w$]+))\s+from\s*['"]?$/i);

            if (!fnMatch) {
                return {
                    suggestions: []
                };
            }

            let symbolName;
            if (fnMatch[1]) {
                const firstName = fnMatch[1].trim().split(/\s*,\s*/)[0];
                symbolName = firstName.split(/\s+as\s+/i)[0].trim();
            } else if (fnMatch[2]) {
                symbolName = fnMatch[2].trim();
            }
            let matches = await FindFilesExporting(symbolName, editor);
            let isFallback = false;

            if (!matches || matches.length === 0) {
                isFallback = true;
                if (editor.script && editor.script.files) {
                    matches = Object.keys(editor.script.files);
                } else {
                    matches = [];
                }

                if (editor.currentPath) {
                    matches = matches.filter(p => p !== editor.currentPath);
                }
            }

            const suggestions = matches.map(path => {
                const rel = getRelativeImportPath(editor, path);

                const hasOpenQuote = /['"]$/.test(textUntilPos);
                const insertText = hasOpenQuote ? rel : `"${rel}"`;

                return {
                    label: rel,
                    kind: monaco.languages.CompletionItemKind.File,
                    insertText: insertText,
                    detail: isFallback ? `File: ${path}` : `Export: ${symbolName}`,
                    sortText: isFallback ? '9999' : '0000'
                };
            });

            return {
                suggestions
            };
        }
    });
}

function getRelativeImportPath(editor, targetPath) {
    if (!editor.currentPath) return './' + targetPath;

    const fromParts = editor.currentPath.split('/').slice(0, -1); // dir of current file
    const toParts = targetPath.split('/');

    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
        i++;
    }

    const up = fromParts.length - i;
    const down = toParts.slice(i).join('/');

    const prefix = up > 0 ? '../'.repeat(up) : './';
    return prefix + down;
}

export function getProjectFileList(editor) {
    const files = [];

    if (editor.mode === 'multi-file-edit' && editor.script?.files) {
        for (const path of Object.keys(editor.script.files)) {
            if (path.toLowerCase().endsWith('.js')) {
                files.push(path);
            }
        }
    } else if (editor.mode === 'workspace' && editor.workspaceHandle) {
        const tree = document.getElementById('fileTree');
        if (!tree) return files;
        tree.querySelectorAll('.tree-item[data-kind="file"]').forEach(item => {
            const p = item.dataset.path;
            if (p && p.toLowerCase().endsWith('.js')) files.push(p);
        });
    }

    return files;
}

async function FindFilesExporting(name, editor) {
    const files = getProjectFileList(editor);
    const matches = [];

    const needle = new RegExp(`\\b${name}\\b`);

    for (const filePath of files) {
        try {
            const summary = await GetFileExportsSummary(filePath, editor);
            if (!summary || summary === '_No exports detected in this file._') continue;

            if (needle.test(summary)) {
                matches.push(filePath);
            }
        } catch (e) {
            console.warn('SmartImports: error in', filePath, e);
        }
    }

    return matches;
}

export async function GetFileExportsSummary(path, editor) {
    let code = null;

    if (editor.mode === 'multi-file-edit' && editor.script?.files?.[path]) {
        code = editor.script.files[path];
    } else if (editor.mode === 'workspace' && editor.workspaceHandle) {
        code = await editor.getFile(path);
    }

    if (!code || typeof code !== 'string') return null;

    const lines = code.split('\n');
    const exports = new Set();

    for (const rawLine of lines) {
        const line = rawLine.trim();
        let m;

        // export default class Blah { ... }
        if ((m = line.match(/^export\s+default\s+class\s+([A-Za-z0-9_]+)/))) {
            exports.add(`default class: ${m[1]}`);
        }
        // export class Blah { ... }
        else if ((m = line.match(/^export\s+class\s+([A-Za-z0-9_]+)/))) {
            exports.add(`class: ${m[1]}`);
        }
        // export default function Blah() { ... }
        else if ((m = line.match(/^export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_]+)/))) {
            exports.add(`default function: ${m[2]}`);
        }
        // export async function Blah() { ... }
        else if ((m = line.match(/^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/))) {
            exports.add(`function: ${m[2]}`);
        }
        // export const Blah = ...
        else if ((m = line.match(/^export\s+const\s+([A-Za-z0-9_]+)/))) {
            exports.add(`const: ${m[1]}`);
        }
        // export let Blah = ...
        else if ((m = line.match(/^export\s+let\s+([A-Za-z0-9_]+)/))) {
            exports.add(`let: ${m[1]}`);
        }
        // export var Blah = ...
        else if ((m = line.match(/^export\s+var\s+([A-Za-z0-9_]+)/))) {
            exports.add(`var: ${m[1]}`);
        }
        // export { a, b as c }
        else if ((m = line.match(/^export\s*{\\s*([^}]+)\s*}/))) {
            const parts = m[1].split(',');
            for (const part of parts) {
                const p = part.trim();
                const asMatch = p.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/);
                if (asMatch) {
                    exports.add(`named: ${asMatch[2]} (from ${asMatch[1]})`);
                } else {
                    const simple = p.match(/^([A-Za-z0-9_]+)/);
                    if (simple) {
                        exports.add(`named: ${simple[1]}`);
                    }
                }
            }
        }
        // export * from './Blah'
        else if ((m = line.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/))) {
            exports.add(`re-export * from: ${m[1]}`);
        }
        // export { a, b } from './Blah'
        else if ((m = line.match(/^export\s*{\\s*([^}]+)\s*}\s*from\s+['"]([^'"]+)['"]/))) {
            const fromPath = m[2];
            const parts = m[1].split(',');
            for (const part of parts) {
                const p = part.trim();
                const asMatch = p.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/);
                if (asMatch) {
                    exports.add(`re-export: ${asMatch[2]} (from ${fromPath})`);
                } else {
                    const simple = p.match(/^([A-Za-z0-9_]+)/);
                    if (simple) {
                        exports.add(`re-export: ${simple[1]} (from ${fromPath})`);
                    }
                }
            }
        }
        // export default Blah;
        else if ((m = line.match(/^export\s+default\s+([A-Za-z0-9_]+)/))) {
            const exportedVar = m[1];
            exports.add(`default: ${exportedVar}`);

            const ctorRegex = new RegExp(
                `\\b(const|let|var)\\s+${exportedVar}\\s*=\\s*new\\s+([A-Za-z0-9_]+)`
            );

            const ctorMatch = code.match(ctorRegex);
            if (ctorMatch) {
                const className = ctorMatch[2];
                exports.add(`default instance of: ${className}`);
            }
        }
        // module.exports = Blah
        else if ((m = line.match(/^module\.exports\s*=\s*/))) {
            if (line.match(/function/)) {
                const nameM = line.match(/function\s+([A-Za-z0-9_$]+)/);
                exports.add(nameM ? `commonjs default function: ${nameM[1]}` : `commonjs default function: (anonymous)`);
            } else if (line.match(/class/)) {
                const nameM = line.match(/class\s+([A-Za-z0-9_$]+)/);
                exports.add(nameM ? `commonjs default class: ${nameM[1]}` : `commonjs default class: (anonymous)`);
            } else if (line.match(/\{/)) {
                exports.add(`commonjs default object`);
            } else {
                const idM = line.match(/^module\.exports\s*=\s*([A-Za-z0-9_$]+)/);
                exports.add(idM ? `commonjs default: ${idM[1]}` : `commonjs default export`);
            }
        }
        // module.exports.name = Blah
        else if ((m = line.match(/^module\.exports\.([A-Za-z0-9_$]+)\s*=/))) {
            exports.add(`commonjs named: ${m[1]}`);
        }
        // exports.name = Blah
        else if ((m = line.match(/^exports\.([A-Za-z0-9_$]+)\s*=/))) {
            exports.add(`commonjs named: ${m[1]}`);
        }
    }

    if (exports.size === 0) {
        return '_No exports detected in this file._';
    }

    return Array.from(exports).slice(0, 20).map(e => `- ${e}`).join('\n');
}

export function CollectDefinedIdentifiers(model) {
    // this was chatgpted cuz im lazy to redo the regex
    const text = model.getValue();
    const ids = new Set();
    let m;

    const importDefault = /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/g;
    while ((m = importDefault.exec(text)) !== null) ids.add(m[1]);

    const importNamed = /\bimport\s*{([^}]+)}\s*from\b/g;
    while ((m = importNamed.exec(text)) !== null) {
        const parts = m[1].split(',');
        for (const p of parts) {
            const nm = /([A-Za-z_$][A-Za-z0-9_$]*)/.exec(p.trim());
            if (nm) ids.add(nm[1]);
        }
    }

    const varLike = /\b(var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((m = varLike.exec(text)) !== null) ids.add(m[2]);

    const funcDecl = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    while ((m = funcDecl.exec(text)) !== null) ids.add(m[1]);

    const classDecl = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
    while ((m = classDecl.exec(text)) !== null) ids.add(m[1]);

    const arrowFunc = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\([^)]*\)\s*=>/g;
    while ((m = arrowFunc.exec(text)) !== null) ids.add(m[1]);

    return Array.from(ids);
}

function Levenshtein(a, b) {
    const la = a.length,
        lb = b.length;
    const dp = Array.from({
        length: la + 1
    }, () => new Array(lb + 1).fill(0));
    for (let i = 0; i <= la; i++) dp[i][0] = i;
    for (let j = 0; j <= lb; j++) dp[0][j] = j;
    for (let i = 1; i <= la; i++) {
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[la][lb];
}

export function FindClosestIdentifier(name, candidates, maxDistance = 3) {
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        if (c === name) continue;
        const d = Levenshtein(name, c);
        if (d < bestDist) {
            bestDist = d;
            best = c;
        }
    }
    return best && bestDist <= maxDistance ? best : null;
}

export function SetupTypoCorrection(editor) {
    monaco.languages.registerCompletionItemProvider('javascript', {
        triggerCharacters: [
            '.', ' ', '\n',
            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
            'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
            'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
        ],

        provideCompletionItems: (model, position) => {
            const wordUntil = model.getWordUntilPosition(position);
            const fullWord = model.getWordAtPosition(position) || wordUntil;
            const name = fullWord && fullWord.word;

            if (!name || name.length < 3) {
                return {
                    suggestions: []
                };
            }

            const definedIds = CollectDefinedIdentifiers(model);

            if (definedIds.includes(name)) {
                return {
                    suggestions: []
                };
            }

            const closest = FindClosestIdentifier(name, definedIds);
            if (!closest || closest === name) {
                return {
                    suggestions: []
                };
            }

            const range = new monaco.Range(
                position.lineNumber,
                fullWord.startColumn,
                position.lineNumber,
                fullWord.endColumn
            );

            editor.typoDecorationIds = model.deltaDecorations(editor.typoDecorationIds || [], [{
                range,
                options: {
                    inlineClassName: 'typoFixUnderline',
                    hoverMessage: {
                        value: `Did you mean ${closest}?`
                    },
                    description: 'TypoFix'
                }
            }]);

            return {
                suggestions: [{
                    label: closest,
                    kind: monaco.languages.CompletionItemKind.Text,
                    insertText: closest,
                    range,
                    sortText: '0000',
                    detail: 'Fix typo'
                }]
            };
        }
    });
}

export function RunTypoAnalysis(editor) {
    if (!editor.editor) return;
    const model = editor.editor.getModel();
    if (!model) return;

    editor.typoDecorationIds = model.deltaDecorations(editor.typoDecorationIds || [], []);

    const pos = editor.editor.getPosition();
    if (!pos) return;

    const wordInfo = model.getWordAtPosition(pos);
    if (!wordInfo || !wordInfo.word || wordInfo.word.length < 3) return;

    const name = wordInfo.word;
    const range = new monaco.Range(
        pos.lineNumber,
        wordInfo.startColumn,
        pos.lineNumber,
        wordInfo.endColumn
    );

    const definedIds = CollectDefinedIdentifiers(model);

    if (definedIds.includes(name)) return;

    const closest = FindClosestIdentifier(name, definedIds);
    if (!closest || closest === name) return;

    editor.typoDecorationIds = model.deltaDecorations(editor.typoDecorationIds || [], [{
        range,
        options: {
            inlineClassName: 'typoFixUnderline',
            hoverMessage: {
                value: `Did you mean **${closest}**?`
            },
            description: 'TypoFix'
        }
    }]);
}