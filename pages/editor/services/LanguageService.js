// services/LanguageService.js
import {
    ImportParser,
    ExportParser,
    JSTokenizer
} from "./Tokenizer.js"
/**
 * Sets up Monaco Editor smart import completions using tokenizer-based parsing.
 * Provides inline completions (top-1) and regular completions (list) for import paths.
 * @param {Object} editor - Monaco editor instance with script/files context
 */
export function SetupSmartImports(editor) {
    const isImportPathCompleteOrInside = (textUntilPos, positionColumn) => {
        const trimmed = textUntilPos.trim();

        if (/['"].*['"]$/.test(trimmed) || trimmed.endsWith(';')) {
            return true;
        }

        const lastQuoteIndex = Math.max(
            textUntilPos.lastIndexOf('"'),
            textUntilPos.lastIndexOf("'")
        );
        if (lastQuoteIndex >= 0 && positionColumn > lastQuoteIndex + 1) {
            return true;
        }

        return false;
    };

    monaco.languages.registerInlineCompletionsProvider('javascript', {
        async provideInlineCompletions(model, position, context, token) {
            const lineText = model.getLineContent(position.lineNumber);
            const textUntilPos = lineText.slice(0, position.column);

            if (isImportPathCompleteOrInside(textUntilPos, position.column)) {
                return {
                    items: []
                };
            }

            const parser = new ImportParser(textUntilPos);
            if (!parser.IsAfterFromOnly()) return {
                items: []
            };

            const symbolName = parser.ParseSymbolName();
            if (!symbolName) return {
                items: []
            };

            const matches = await FindFilesExporting(symbolName, editor);
            if (!matches?.length) return {
                items: []
            };

            const chosenPath = matches[0];
            const rel = getRelativeImportPath(editor, chosenPath);

            const hasOpenQuote = /['"]$/.test(textUntilPos);
            const ghostText = hasOpenQuote ? `"${rel}"` : `"${rel}"`;

            return {
                items: [{
                    insertText: ghostText,
                    range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column
                    },
                    command: {
                        id: 'acceptGhostText',
                        title: 'Accept import path'
                    }
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

            if (isImportPathCompleteOrInside(textUntilPos, position.column)) {
                return {
                    suggestions: []
                };
            }

            const parser = new ImportParser(textUntilPos);
            if (!parser.IsAfterFromOnly()) return {
                suggestions: []
            };

            const symbolName = parser.ParseSymbolName();
            if (!symbolName) return {
                suggestions: []
            };

            let matches = await FindFilesExporting(symbolName, editor);
            let isFallback = false;

            if (!matches?.length) {
                isFallback = true;
                matches = editor.script?.files ? Object.keys(editor.script.files) : [];
                if (editor.currentPath) {
                    matches = matches.filter(p => p !== editor.currentPath);
                }
            }

            const suggestions = matches.map(path => {
                const rel = getRelativeImportPath(editor, path);
                const hasOpenQuote = /['"]$/.test(textUntilPos);
                const insertText = hasOpenQuote ? rel : `"${rel}"`;

                let exportInfo = '';
                if (!isFallback && editor.script?.files?.[path]) {
                    const fileContent = editor.script.files[path];
                    const exportParser = new ExportParser(fileContent);
                    const exports = exportParser.ParseAllExports();
                    const matchingExport = exports.find(exp => exp.name === symbolName);
                    if (matchingExport) {
                        exportInfo = `${matchingExport.kind}: ${matchingExport.type}`;
                        if (matchingExport.params) exportInfo += `(${matchingExport.params})`;
                    }
                }

                return {
                    label: rel,
                    kind: monaco.languages.CompletionItemKind.File,
                    insertText: insertText,
                    detail: isFallback ? `File: ${path}` : `Export: ${symbolName} ${exportInfo}`,
                    documentation: exportInfo ? `Type: ${exportInfo}` : undefined,
                    sortText: isFallback ? '9999' : '0000',
                    range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column
                    }
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

    const lines = [];

    const exportParser = new ExportParser(code);
    const esExports = exportParser.ParseAllExports();
    for (const e of esExports) {
        if (e.kind === 'class') {
            lines.push(e.name === 'default' ? 'default class: (anonymous)' : `class: ${e.name}`);
        } else if (e.kind === 'function') {
            lines.push(e.name === 'default' ? 'default function: (anonymous)' : `function: ${e.name}`);
        } else {
            lines.push(e.name === 'default' ? `default: ${e.type}` : `const: ${e.name}`);
        }
    }

    const commonjsExports = parseCommonJSExports(code);
    for (const exp of commonjsExports) {
        lines.push(exp);
    }

    if (lines.length === 0) {
        return '_No exports detected in this file._';
    }

    return lines.slice(0, 20).map(e => `- ${e}`).join('\n');
}

function parseCommonJSExports(code) {
    const tokenizer = new JSTokenizer(code);
    const exports = [];

    tokenizer.pos = 0;
    while (!tokenizer.IsAtEnd()) {
        tokenizer.SkipWhitespaceAndComments();

        const savedPos = tokenizer.SavePosition();

        if (tokenizer.MatchSequence('module.exports')) {
            tokenizer.SkipWhitespaceAndComments();
            if (tokenizer.MatchChar('=')) {
                tokenizer.SkipWhitespaceAndComments();

                if (tokenizer.MatchKeyword('function')) {
                    const name = tokenizer.ReadIdentifier();
                    exports.push(name ? `commonjs default function: ${name}` : 'commonjs default function: (anonymous)');
                }
                else if (tokenizer.MatchChar('{')) {
                    exports.push('commonjs default object');
                }
                else {
                    const id = tokenizer.ReadIdentifier();
                    exports.push(id ? `commonjs default: ${id}` : 'commonjs default export');
                }
            }
        }
        else if (tokenizer.MatchSequence('module.exports.')) {
            const prop = tokenizer.ReadIdentifier();
            if (prop && tokenizer.MatchChar('=')) {
                exports.push(`commonjs named: ${prop}`);
            }
        }
        else if (tokenizer.MatchSequence('exports.')) {
            const prop = tokenizer.ReadIdentifier();
            if (prop && tokenizer.MatchChar('=')) {
                exports.push(`commonjs named: ${prop}`);
            }
        } else {
            tokenizer.RestorePosition(savedPos);
            tokenizer.Advance();
        }
    }

    return exports;
}

const collectIds = new WeakMap();

export function CollectDefinedIdentifiers(model) {
    if (!model) return [];

    const versionId = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
    const cached = collectIds.get(model);
    if (cached && cached.versionId === versionId) {
        return cached.ids.slice();
    }

    const text = typeof model.getValue === 'function' ? model.getValue() : (model.getValue && model.getValue()) || model;
    if (!text || !String(text).trim()) {
        collectIds.set(model, {
            versionId,
            ids: []
        });
        return [];
    }

    const tokenizer = new JSTokenizer(text);
    const ids = new Set();

    while (!tokenizer.IsAtEnd()) {
        tokenizer.SkipWhitespaceAndComments();

        if (tokenizer.IsAtEnd()) break;

        if (tokenizer.MatchKeyword('import')) {
            tokenizer.SkipWhitespaceAndComments();
            const importName = tokenizer.ReadIdentifier();
            if (importName) {
                tokenizer.SkipWhitespaceAndComments();
                if (tokenizer.MatchKeyword('from')) {
                    ids.add(importName);
                }
            }
            continue;
        }

        if (tokenizer.MatchKeyword('import')) {
            tokenizer.SkipWhitespaceAndComments();
            if (tokenizer.Peek() === '{') {
                const braceContent = tokenizer.ExtractBetween('{', '}');
                if (braceContent) {
                    const braceTokenizer = new JSTokenizer(braceContent);
                    while (!braceTokenizer.IsAtEnd()) {
                        braceTokenizer.SkipWhitespaceAndComments();
                        const name = braceTokenizer.ReadIdentifier();
                        if (name) ids.add(name);
                        braceTokenizer.SkipWhitespaceAndComments();
                        braceTokenizer.MatchChar(',');
                    }
                }
                tokenizer.SkipWhitespaceAndComments();
                tokenizer.MatchKeyword('from');
            }
            continue;
        }

        if (tokenizer.MatchKeyword('var') || tokenizer.MatchKeyword('let') || tokenizer.MatchKeyword('const')) {
            tokenizer.SkipWhitespaceAndComments();
            const name = tokenizer.ReadIdentifier();
            if (name) ids.add(name);
            continue;
        }

        if (tokenizer.MatchKeyword('function')) {
            tokenizer.SkipWhitespaceAndComments();
            const funcName = tokenizer.ReadIdentifier();
            if (funcName) ids.add(funcName);
            tokenizer.ExtractBetween('(', ')');
            continue;
        }

        if (tokenizer.MatchKeyword('class')) {
            tokenizer.SkipWhitespaceAndComments();
            const className = tokenizer.ReadIdentifier();
            if (className) ids.add(className);
            continue;
        }

        if ((tokenizer.MatchKeyword('const') || tokenizer.MatchKeyword('let') || tokenizer.MatchKeyword('var')) ||
            tokenizer.ReadIdentifier()) {
            const savedPos = tokenizer.SavePosition();
            tokenizer.SkipWhitespaceAndComments();

            if (tokenizer.MatchChar('=')) {
                tokenizer.SkipWhitespaceAndComments();

                const paramStart = tokenizer.SavePosition();
                if (tokenizer.Peek() === '(') {
                    tokenizer.ExtractBetween('(', ')');
                    tokenizer.SkipWhitespaceAndComments();
                } else {
                    tokenizer.ReadIdentifier();
                    tokenizer.SkipWhitespaceAndComments();
                }

                if (tokenizer.MatchSequence('=>')) {
                    tokenizer.RestorePosition(savedPos);
                    const arrowName = tokenizer.ReadIdentifier();
                    if (arrowName) ids.add(arrowName);
                } else {
                    tokenizer.RestorePosition(paramStart);
                }
            }
            tokenizer.RestorePosition(savedPos);
        }

        tokenizer.Advance();
    }

    const result = Array.from(ids);
    collectIds.set(model, {
        versionId,
        ids: result.slice()
    });
    return result;
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

export const jsBuiltIns = new Set([
    'function', 'const', 'let', 'var', 'class', 'if', 'else', 'while', 'for',
    'do', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch',
    'finally', 'throw', 'new', 'this', 'typeof', 'instanceof', 'void', 'delete',
    'in', 'of', 'async', 'await', 'yield', 'import', 'export', 'from', 'default',
    'extends', 'super', 'static', 'get', 'set', 'true', 'false', 'null', 'undefined',
    'console', 'window', 'document', 'Math', 'Date', 'Array', 'Object', 'String',
    'Number', 'Boolean', 'RegExp', 'Error', 'JSON', 'Promise', 'Set', 'Map',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt',
    'parseFloat', 'isNaN', 'isFinite', 'Infinity', 'NaN', 'eval', 'encodeURI',
    'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'alert', 'confirm',
    'prompt', 'fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage',
    'navigator', 'location', 'history', 'crypto', 'performance', 'requestAnimationFrame',
    'cancelAnimationFrame', 'URL', 'Blob', 'File', 'FileReader', 'FormData',
    'Headers', 'Request', 'Response', 'WebSocket', 'Worker', 'Symbol', 'Proxy',
    'Reflect', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt', 'WeakMap', 'WeakSet', 'Intl', 'BigInt64Array', 'BigUint64Array'
]);

export function SetupTypoCorrection(editor) {

    monaco.languages.registerCompletionItemProvider('javascript', {
        triggerCharacters: ['.', ' ', '\n'],

        provideCompletionItems: (model, position) => {
            if (typeof model.getValueLength === 'function' && model.getValueLength() > 200000) {
                return {
                    suggestions: []
                };
            }

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
                        value: `Did you mean **${closest}**?`
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
                    detail: `Fix typo → ${closest}`
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