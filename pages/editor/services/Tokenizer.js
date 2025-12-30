/**
 * Base tokenizer class for character-by-character JavaScript parsing.
 * Provides utilities for whitespace, comments, identifiers, and keywords.
 * @export
 */
export class JSTokenizer {
    constructor(text) {
        this.text = text;
        this.pos = 0;
        this.length = text.length;
    }

    Peek(offset = 0) {
        return this.text[this.pos + offset] || null;
    }

    Advance(count = 1) {
        this.pos = Math.min(this.pos + count, this.length);
    }

    SavePosition() {
        return this.pos;
    }

    RestorePosition(pos) {
        this.pos = pos;
    }

    IsAtEnd() {
        return this.pos >= this.length;
    }

    SkipWhitespace() {
        const text = this.text;
        const length = this.length;
        while (this.pos < length && /\s/.test(text[this.pos])) {
            this.pos++;
        }
    }

    SkipComments() {
        const text = this.text;
        if (text.startsWith('//', this.pos)) {
            while (this.pos < this.length && text[this.pos] !== '\n') {
                this.pos++;
            }
            return true;
        } else if (text.startsWith('/*', this.pos)) {
            this.pos += 2;
            while (this.pos < this.length && !text.startsWith('*/', this.pos)) {
                this.pos++;
            }
            if (text.startsWith('*/', this.pos)) this.pos += 2;
            return true;
        }
        return false;
    }

    SkipWhitespaceAndComments() {
        let skipped;
        const text = this.text;
        do {
            skipped = false;
            const beforeWs = this.pos;
            this.SkipWhitespace();
            if (beforeWs !== this.pos) skipped = true;

            if (this.SkipComments()) skipped = true;
        } while (skipped);
    }

    ReadIdentifier() {
        this.SkipWhitespaceAndComments();
        const start = this.pos;

        if (this.pos >= this.length || !/[a-zA-Z_$]/.test(this.text[this.pos])) {
            return null;
        }

        while (this.pos < this.length && /[a-zA-Z0-9_$]/.test(this.text[this.pos])) {
            this.pos++;
        }

        return this.text.slice(start, this.pos);
    }

    MatchKeyword(keyword) {
        this.SkipWhitespaceAndComments();
        const savedPos = this.pos;
        const identifier = this.ReadIdentifier();

        if (identifier && identifier.toLowerCase() === keyword.toLowerCase()) {
            return true;
        }

        this.pos = savedPos;
        return false;
    }

    ReadString() {
        this.SkipWhitespaceAndComments();
        const quote = this.Peek();

        if (quote !== '"' && quote !== "'" && quote !== '`') {
            return null;
        }

        this.Advance();
        const start = this.pos;

        while (!this.IsAtEnd() && this.Peek() !== quote) {
            if (this.Peek() === '\\') this.Advance(2);
            else this.Advance();
        }

        const value = this.text.slice(start, this.pos);
        if (this.Peek() === quote) this.Advance();

        return value;
    }

    MatchChar(char) {
        this.SkipWhitespaceAndComments();
        if (this.Peek() === char) {
            this.Advance();
            return true;
        }
        return false;
    }

    MatchSequence(sequence) {
        this.SkipWhitespaceAndComments();
        if (this.text.startsWith(sequence, this.pos)) {
            this.pos += sequence.length;
            return true;
        }
        return false;
    }

    ExtractBetween(openChar, closeChar) {
        if (!this.MatchChar(openChar)) return null;

        let depth = 1;
        const start = this.pos;
        const text = this.text;

        while (!this.IsAtEnd() && depth > 0) {
            const char = this.Peek();

            if (char === '"' || char === "'" || char === '`') {
                const quote = char;
                this.Advance();
                while (!this.IsAtEnd() && this.Peek() !== quote) {
                    if (this.Peek() === '\\') this.Advance(2);
                    else this.Advance();
                }
                if (this.Peek() === quote) this.Advance();
                continue;
            }

            if (char === openChar) depth++;
            else if (char === closeChar) depth--;

            if (depth > 0) this.Advance();
        }

        const content = this.text.slice(start, this.pos);
        if (this.Peek() === closeChar) this.Advance();

        return content;
    }

    IsIdentifierChar(char) {
        if (!char) return false;
        return /[a-zA-Z0-9_$]/.test(char);
    }
}

/**
 * Specialized parser for JavaScript import statements.
 * @extends JSTokenizer
 */
export class ImportParser extends JSTokenizer {
    ParseImportStatement() {
        if (!this.MatchKeyword('import')) return null;

        const specifier = this.ParseSpecifierr();
        if (!specifier) return null;

        if (!this.MatchKeyword('from')) return null;

        this.SkipWhitespaceAndComments();
        const hasQuoteAtEnd = /['"]$/.test(this.text.slice(Math.max(0, this.pos - 1), this.pos + 1));

        return {
            symbolName: specifier.symbolName,
            isAfterFrom: this.IsAtEnd() || hasQuoteAtEnd
        };
    }

    ParseSpecifierr() {
        const savedPos = this.SavePosition();

        if (this.MatchChar('{')) {
            const firstName = this.ReadIdentifier();
            if (firstName) {
                while (!this.IsAtEnd() && !this.MatchChar('}')) {
                    this.Advance();
                }
                return {
                    symbolName: firstName
                };
            }
        }

        this.RestorePosition(savedPos);
        const identifier = this.ReadIdentifier();
        if (identifier) {
            return {
                symbolName: identifier
            };
        }

        return null;
    }

    ParseSymbolName() {
        const result = this.ParseImportStatement();
        return result ? result.symbolName : null;
    }

    IsAfterFromOnly() {
        const savedPos = this.SavePosition();
        this.pos = 0;

        const result = this.ParseImportStatement();
        this.RestorePosition(savedPos);

        return result ? result.isAfterFrom : false;
    }
}

/**
 * Specialized parser for JavaScript function signatures.
 * @extends JSTokenizer
 */
export class FunctionParser extends JSTokenizer {
    ParseFunctionSignature() {
        this.SkipWhitespaceAndComments();

        const saved = this.SavePosition();
        let foundFunctionKeyword = false;

        if (this.MatchKeyword('function')) {
            foundFunctionKeyword = true;
        } else {
            while (!this.IsAtEnd()) {
                if (this.MatchChar('=')) {
                    this.SkipWhitespaceAndComments();
                    if (this.MatchKeyword('function')) {
                        foundFunctionKeyword = true;
                        break;
                    }
                }
                this.Advance();
            }
        }

        if (!foundFunctionKeyword) {
            this.RestorePosition(saved);
            return null;
        }

        const functionName = this.ReadIdentifier();

        const paramsContent = this.ExtractBetween('(', ')');
        if (paramsContent === null) return null;

        this.SkipWhitespaceAndComments();
        let functionBody = "";
        if (this.Peek() === '{') {
            functionBody = this.ExtractBetween('{', '}');
        }

        const params = this.ParseParameters(paramsContent, functionBody);

        let isArrow = false;
        const arrowSaved = this.SavePosition();
        this.SkipWhitespaceAndComments();
        if (this.MatchSequence('=>')) {
            isArrow = true;
        } else {
            this.RestorePosition(arrowSaved);
        }

        return {
            name: functionName,
            parameters: params,
            isArrow: isArrow,
            raw: paramsContent
        };
    }

    ParseParameters(paramsText, functionBody) {
        if (!paramsText || !paramsText.trim()) return [];

        const params = [];
        const parser = new JSTokenizer(paramsText);

        while (!parser.IsAtEnd()) {
            const param = this.ParseParameter(parser, functionBody);
            if (param) params.push(param);

            parser.SkipWhitespaceAndComments();
            if (parser.MatchChar(',')) continue;
            else break;
        }

        return params;
    }

    ParseParameter(parser, functionBody) {
        parser.SkipWhitespaceAndComments();

        if (parser.Peek() === '{' || parser.Peek() === '[') {
            const isObject = parser.Peek() === '{';
            const destructure = parser.ExtractBetween(
                parser.Peek(),
                isObject ? '}' : ']'
            );
            return {
                name: destructure,
                type: 'destructured',
                jsType: isObject ? 'Object' : 'Array'
            };
        }

        if (parser.MatchSequence('...')) {
            const name = parser.ReadIdentifier();
            return {
                name: name || 'rest',
                type: 'rest',
                jsType: 'any[]'
            };
        }

        const name = parser.ReadIdentifier();
        if (!name) return null;

        let defaultValue = null;
        let inferredType = 'any';

        parser.SkipWhitespaceAndComments();
        if (parser.MatchChar('=')) {
            parser.SkipWhitespaceAndComments();
            const start = parser.pos;
            let depth = 0;

            while (!parser.IsAtEnd()) {
                const char = parser.Peek();
                if (char === ',' && depth === 0) break;
                if (char === '(' || char === '{' || char === '[') depth++;
                if (char === ')' || char === '}' || char === ']') {
                    if (depth === 0) break;
                    depth--;
                }
                parser.Advance();
            }

            defaultValue = parser.text.slice(start, parser.pos).trim();
            inferredType = this.InferTypeFromValue(defaultValue);
        }

        if (inferredType === 'any' && functionBody) {
            inferredType = this.InferTypeFromUsage(name, functionBody);
        }

        return {
            name,
            type: 'normal',
            defaultValue,
            jsType: inferredType
        };
    }

    InferTypeFromValue(valueText) {
        if (!valueText) return 'any';

        const t = new JSTokenizer(valueText);
        t.SkipWhitespaceAndComments();

        if (t.MatchKeyword('true') || t.MatchKeyword('false')) return 'boolean';
        if (t.MatchKeyword('null')) return 'null';
        if (t.MatchKeyword('undefined')) return 'undefined';

        const firstChar = t.Peek();
        if (firstChar === '"' || firstChar === "'" || firstChar === '`') return 'string';
        if (firstChar === '[') return 'Array';
        if (firstChar === '{') return 'Object';
        if (/[0-9]/.test(firstChar) || firstChar === '-' || firstChar === '.') return 'number';

        return 'any';
    }

    InferTypeFromUsage(paramName, bodyText) {
        const scanner = new JSTokenizer(bodyText);

        while (!scanner.IsAtEnd()) {
            scanner.SkipWhitespaceAndComments();

            if (scanner.IsAtEnd()) break;

            const currentChar = scanner.Peek();
            if (currentChar === '"' || currentChar === "'" || currentChar === '`') {
                const stringStart = scanner.pos;
                scanner.ReadString();
                scanner.SkipWhitespaceAndComments();

                if (scanner.MatchChar('+')) {
                    scanner.SkipWhitespaceAndComments();
                    const nextId = scanner.ReadIdentifier();
                    if (nextId === paramName) {
                        return 'string';
                    }
                }
                continue;
            }

            if (scanner.MatchKeyword('if') || scanner.MatchKeyword('while')) {
                scanner.SkipWhitespaceAndComments();
                if (scanner.MatchChar('(')) {
                    scanner.SkipWhitespaceAndComments();

                    const hasNegation = scanner.MatchChar('!');
                    scanner.SkipWhitespaceAndComments();

                    const condId = scanner.ReadIdentifier();
                    if (condId === paramName) {
                        scanner.SkipWhitespaceAndComments();
                        const afterParam = scanner.Peek();

                        if (afterParam === ')' || afterParam === '&' || afterParam === '|' || hasNegation) {
                            return 'boolean';
                        }
                    }
                }
                continue;
            }

            const identifier = scanner.ReadIdentifier();

            if (identifier === paramName) {
                scanner.SkipWhitespaceAndComments();
                const nextChar = scanner.Peek();

                if (nextChar === '.') {
                    scanner.Advance();
                    scanner.SkipWhitespaceAndComments();
                    const prop = scanner.ReadIdentifier();

                    if (prop) {
                        const stringMethods = ['substring', 'substr', 'slice', 'trim', 'trimStart', 'trimEnd', 'charAt', 'charCodeAt', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll', 'toLowerCase', 'toUpperCase', 'padStart', 'padEnd', 'repeat'];

                        const arrayMethods = ['push', 'pop', 'shift', 'unshift', 'map', 'filter', 'forEach', 'reduce', 'find', 'findIndex', 'some', 'every', 'join', 'concat', 'slice', 'splice'];

                        const numberMethods = ['toFixed', 'toPrecision', 'toExponential'];

                        if (stringMethods.includes(prop)) return 'string';
                        if (arrayMethods.includes(prop)) return 'Array';
                        if (numberMethods.includes(prop)) return 'number';

                        if (prop !== 'length') {
                            return 'Object';
                        }
                    }
                    continue;
                }

                if (nextChar === '[') {
                    return 'Array';
                }

                if (nextChar === '+') {
                    scanner.Advance();
                    scanner.SkipWhitespaceAndComments();

                    const isCompound = scanner.Peek() === '=';
                    if (isCompound) scanner.Advance();

                    scanner.SkipWhitespaceAndComments();
                    const afterPlus = scanner.Peek();

                    if (afterPlus === '"' || afterPlus === "'" || afterPlus === '`') {
                        return 'string';
                    }

                    if (/[0-9]/.test(afterPlus)) {
                        return 'number';
                    }
                    continue;
                }

                if (nextChar === '-' || nextChar === '*' || nextChar === '/' || nextChar === '%') {
                    if (nextChar === '-' && scanner.text[scanner.pos + 1] === '>') {
                        scanner.Advance(2);
                        continue;
                    }
                    return 'number';
                }

                if (scanner.MatchSequence('-=') || scanner.MatchSequence('*=') ||
                    scanner.MatchSequence('/=') || scanner.MatchSequence('%=')) {
                    return 'number';
                }

                if (scanner.MatchSequence('===') || scanner.MatchSequence('!==') ||
                    scanner.MatchSequence('==') || scanner.MatchSequence('!=') ||
                    nextChar === '>' || nextChar === '<') {

                    if (nextChar === '>' || nextChar === '<') scanner.Advance();
                    scanner.SkipWhitespaceAndComments();

                    const compareChar = scanner.Peek();
                    if (compareChar === '"' || compareChar === "'" || compareChar === '`') {
                        return 'string';
                    }
                    if (scanner.MatchKeyword('true') || scanner.MatchKeyword('false')) {
                        return 'boolean';
                    }
                    if (/[0-9]/.test(compareChar)) {
                        return 'number';
                    }
                }

            } else if (identifier) {
                scanner.SkipWhitespaceAndComments();
                if (scanner.MatchChar('(')) {
                    scanner.SkipWhitespaceAndComments();
                    const argId = scanner.ReadIdentifier();

                    if (argId === paramName) {
                        const stringFunctions = ['alert', 'confirm', 'prompt', 'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI'];

                        const numberFunctions = ['isNaN', 'isFinite', 'Math.abs', 'Math.floor', 'Math.ceil', 'Math.round', 'parseInt', 'parseFloat'];

                        if (stringFunctions.includes(identifier)) return 'string';
                        if (numberFunctions.includes(identifier)) return 'number';
                    }
                }
            } else {
                scanner.Advance();
            }
        }

        return 'any';
    }
}

/**
 * Extended tokenizer for detecting function declarations in code.
 */
export class FunctionDetector extends JSTokenizer {
    HasFunctionDeclaration() {
        this.SkipWhitespaceAndComments();

        const savedPos = this.SavePosition();
        this.MatchKeyword('async');

        if (this.MatchKeyword('function')) {
            return true;
        }

        this.RestorePosition(savedPos);

        if (this.MatchKeyword('const') || this.MatchKeyword('let') || this.MatchKeyword('var')) {
            const identifier = this.ReadIdentifier();
            if (!identifier) return false;

            this.SkipWhitespaceAndComments();
            if (!this.MatchChar('=')) return false;

            this.SkipWhitespaceAndComments();
            this.MatchKeyword('async');

            if (this.Peek() === '(') return true;
            if (this.MatchKeyword('function')) return true;

            return false;
        }

        const identifier = this.ReadIdentifier();
        if (identifier) {
            this.SkipWhitespaceAndComments();

            if (this.MatchChar(':')) {
                this.SkipWhitespaceAndComments();
                this.MatchKeyword('async');
                if (this.MatchKeyword('function') || this.Peek() === '(') {
                    return true;
                }
            }

            if (this.Peek() === '(') {
                return true;
            }
        }

        return false;
    }
}

/**
 * Specialized parser for detecting JavaScript exports and their types.
 * @extends JSTokenizer
 */
export class ExportParser extends JSTokenizer {
    /**
     * Finds all exports in the text and returns their names and inferred types.
     * @returns {Array<{name: string, type: string, kind: string}>}
     */
    ParseAllExports() {
        const exports = [];
        this.pos = 0;

        while (!this.IsAtEnd()) {
            this.SkipWhitespaceAndComments();

            const exportItem = this.ParseExportStatement();
            if (exportItem) {
                exports.push(exportItem);
            } else {
                this.Advance();
            }
        }

        return exports;
    }

    /**
     * Parses a single export statement.
     * @returns {Object|null} Export information or null
     */
    ParseExportStatement() {
        const saved = this.SavePosition();

        if (!this.MatchKeyword('export')) {
            this.RestorePosition(saved);
            return null;
        }

        this.SkipWhitespaceAndComments();

        if (this.MatchKeyword('default')) {
            return this.ParseDefaultExport();
        }

        if (this.Peek() === '{') {
            return this.ParseNamedExportList();
        }

        if (this.MatchKeyword('class')) {
            const name = this.ReadIdentifier();
            return {
                name: name || 'default',
                type: 'any',
                kind: 'class'
            };
        }

        if (this.MatchKeyword('function')) {
            const name = this.ReadIdentifier();

            const paramsContent = this.ExtractBetween('(', ')');
            this.SkipWhitespaceAndComments();

            let functionBody = "";
            if (this.Peek() === '{') {
                functionBody = this.ExtractBetween('{', '}');
            }

            let returnType = 'any';
            if (functionBody) {
                returnType = this.InferReturnType(functionBody);
            }

            return {
                name: name || 'default',
                type: returnType,
                kind: 'function',
                params: paramsContent || ''
            };
        }

        if (this.MatchKeyword('const') || this.MatchKeyword('let') || this.MatchKeyword('var')) {
            const name = this.ReadIdentifier();
            if (!name) return null;

            this.SkipWhitespaceAndComments();

            if (this.MatchChar('=')) {
                this.SkipWhitespaceAndComments();

                const inferredType = this.InferExportedValueType();

                return {
                    name,
                    type: inferredType,
                    kind: inferredType === 'function' ? 'function' : 'variable'
                };
            }

            return {
                name,
                type: 'any',
                kind: 'variable'
            };
        }

        this.RestorePosition(saved);
        return null;
    }

    ParseDefaultExport() {
        this.SkipWhitespaceAndComments();

        if (this.MatchKeyword('function')) {
            const name = this.ReadIdentifier();
            return {
                name: name || 'default',
                type: 'function',
                kind: 'function'
            };
        }

        if (this.MatchKeyword('class')) {
            const name = this.ReadIdentifier();
            return {
                name: name || 'default',
                type: 'class',
                kind: 'class'
            };
        }

        const type = this.InferExportedValueType();
        return {
            name: 'default',
            type,
            kind: 'variable'
        };
    }

    ParseNamedExportList() {
        const names = this.ExtractBetween('{', '}');
        if (!names) return null;

        const parser = new JSTokenizer(names);
        const firstName = parser.ReadIdentifier();

        if (firstName) {
            return {
                name: firstName,
                type: 'any',
                kind: 'variable'
            };
        }

        return null;
    }

    InferExportedValueType() {
        this.SkipWhitespaceAndComments();
        const char = this.Peek();

        if (this.MatchKeyword('function') || this.Peek() === '(') {
            return 'function';
        }

        const saved = this.SavePosition();
        if (char === '(') {
            this.ExtractBetween('(', ')');
            this.SkipWhitespaceAndComments();
            if (this.MatchSequence('=>')) {
                this.RestorePosition(saved);
                return 'function';
            }
        }
        this.RestorePosition(saved);

        if (this.MatchKeyword('class')) {
            return 'class';
        }

        if (char === '"' || char === "'" || char === '`') return 'string';
        if (char === '[') return 'Array';
        if (char === '{') return 'Object';
        if (/[0-9]/.test(char) || char === '-') return 'number';
        if (this.MatchKeyword('true') || this.MatchKeyword('false')) return 'boolean';

        return 'any';
    }

    InferReturnType(bodyText) {
        const scanner = new JSTokenizer(bodyText);

        while (!scanner.IsAtEnd()) {
            scanner.SkipWhitespaceAndComments();

            if (scanner.MatchKeyword('return')) {
                scanner.SkipWhitespaceAndComments();
                const char = scanner.Peek();

                if (char === '"' || char === "'" || char === '`') return 'string';
                if (char === '[') return 'Array';
                if (char === '{') return 'Object';
                if (/[0-9]/.test(char)) return 'number';
                if (scanner.MatchKeyword('true') || scanner.MatchKeyword('false')) return 'boolean';

                break;
            }

            scanner.Advance();
        }

        return 'any';
    }

    /**
     * Quick check if a symbol name is exported in the text.
     * @param {string} symbolName - The symbol to search for
     * @returns {boolean}
     */
    HasExport(symbolName) {
        this.pos = 0;

        while (!this.IsAtEnd()) {
            this.SkipWhitespaceAndComments();

            if (this.MatchKeyword('export')) {
                this.SkipWhitespaceAndComments();

                const isDefault = this.MatchKeyword('default');
                if (isDefault && symbolName === 'default') return true;

                if (this.Peek() === '{') {
                    const content = this.ExtractBetween('{', '}');
                    if (content && content.includes(symbolName)) return true;
                }

                this.MatchKeyword('const') || this.MatchKeyword('let') ||
                    this.MatchKeyword('var') || this.MatchKeyword('function') ||
                    this.MatchKeyword('class');

                const name = this.ReadIdentifier();
                if (name === symbolName) return true;
            } else {
                this.Advance();
            }
        }

        return false;
    }
}