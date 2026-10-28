#!/usr/bin/env python3
"""Copies an extension folder with the comments taken out, for packaging.

    strip-comments.py SRC DEST

.js files lose // and /* */ comments; .html files lose <!-- --> comments and the
comments in their <style> and inline <script> blocks; .css files lose /* */
comments. Lines left empty by a removed comment go, and runs of blank lines
become one. Everything else is copied as it is. Code is otherwise untouched (no
minifying), so the package stays readable for the Web Store review.

The JavaScript is tokenized (strings, template literals with nested ${},
regular expressions), so // inside a string or a regex is left alone. As a
check, the tokens of each file other than comments must come out the same as
they went in, or nothing is written.
"""
import os
import re
import shutil
import sys

MARK = '\x00'  # stands where a comment was, until the lines are tidied

# After these, a / starts a regular expression rather than dividing.
REGEX_AFTER_WORDS = {'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
                     'throw', 'case', 'do', 'else', 'yield', 'await'}
WORD = re.compile(r'[A-Za-z0-9_$\u0080-￿]')


class StripError(Exception):
    pass


def js_tokens(src):
    """Yields (kind, text) for the whole source: 'comment', 'space' or 'code'."""
    i, n = 0, len(src)
    last = None    # the last significant token, to tell a regex from a division
    stack = []     # '{' for a brace, '`' for the ${ of a template literal

    def template(i):
        # from just after a backtick or a closing } of ${...}; returns the end index
        # and whether it stopped at a ${ (True) or the closing backtick (False)
        while i < n:
            c = src[i]
            if c == '\\':
                i += 2
            elif c == '`':
                return i + 1, False
            elif c == '$' and src.startswith('${', i):
                return i + 2, True
            else:
                i += 1
        raise StripError('unterminated template literal')

    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            j = i
            while j < n and src[j] in ' \t\r\n':
                j += 1
            yield 'space', src[i:j]
            i = j
        elif src.startswith('//', i):
            j = src.find('\n', i)
            j = n if j < 0 else j
            yield 'comment', src[i:j]
            i = j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            if j < 0:
                raise StripError('unterminated /* comment')
            yield 'comment', src[i:j + 2]
            i = j + 2
        elif c in '\'"':
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == '\n':
                    raise StripError('newline in a string at %d' % i)
                j += 2 if src[j] == '\\' else 1
            if j >= n:
                raise StripError('unterminated string at %d' % i)
            yield 'code', src[i:j + 1]
            last = ('str', None)
            i = j + 1
        elif c == '`':
            j, opened = template(i + 1)
            if opened:
                stack.append('`')
            yield 'code', src[i:j]
            last = ('punct', '{') if opened else ('str', None)
            i = j
        elif c == '}' and stack and stack[-1] == '`':
            stack.pop()
            j, opened = template(i + 1)
            if opened:
                stack.append('`')
            yield 'code', src[i:j]
            last = ('punct', '{') if opened else ('str', None)
            i = j
        elif c == '/' and (last is None or (last[0] == 'punct' and last[1] not in ')]}')
                           or (last[0] == 'word' and last[1] in REGEX_AFTER_WORDS)):
            j, in_class = i + 1, False
            while True:
                if j >= n or src[j] == '\n':
                    raise StripError('unterminated regular expression at %d' % i)
                ch = src[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '[':
                    in_class = True
                elif ch == ']':
                    in_class = False
                elif ch == '/' and not in_class:
                    break
                j += 1
            j += 1
            while j < n and WORD.match(src[j]):
                j += 1
            yield 'code', src[i:j]
            last = ('regex', None)
            i = j
        elif WORD.match(c):
            j = i
            while j < n and WORD.match(src[j]):
                j += 1
            # a number's decimal point or exponent sign stays with it
            while j < n and src[i].isdigit() and (src[j] == '.' or (src[j] in '+-' and src[j - 1] in 'eE')):
                j += 1
                while j < n and WORD.match(src[j]):
                    j += 1
            yield 'code', src[i:j]
            last = ('word', src[i:j])
            i = j
        else:
            if c == '{':
                stack.append('{')
            elif c == '}' and stack:
                stack.pop()
            yield 'code', c
            last = ('punct', c)
            i += 1


def css_tokens(src):
    i, n = 0, len(src)
    while i < n:
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            if j < 0:
                raise StripError('unterminated /* comment in CSS')
            yield 'comment', src[i:j + 2]
            i = j + 2
        elif src[i] in '\'"':
            j = i + 1
            while j < n and src[j] != src[i]:
                j += 2 if src[j] == '\\' else 1
            yield 'code', src[i:j + 1]
            i = j + 1
        else:
            j = i
            while j < n and not src.startswith('/*', j) and src[j] not in '\'"':
                j += 1
            yield 'code', src[i:j]
            i = j


def drop_comments(tokens):
    out = []
    for kind, text in tokens:
        if kind == 'comment':
            # a comment running over lines keeps one line break (it can end a statement)
            out.append(MARK + ('\n' + MARK if '\n' in text else ''))
        else:
            out.append(text)
    return ''.join(out)


def tidy(text):
    lines, blank = [], True
    for line in text.split('\n'):
        had_comment = MARK in line
        line = line.replace(MARK, '').rstrip()
        if not line.strip():
            if had_comment or blank:
                continue
            blank = True
        else:
            blank = False
        lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines) + '\n'


def significant(tokens):
    return [t for k, t in tokens if k == 'code' and t.strip()]


def strip_js(src):
    out = tidy(drop_comments(js_tokens(src)))
    if significant(js_tokens(src)) != significant(js_tokens(out)):
        raise StripError('code changed while stripping')
    return out


def strip_css(src):
    out = tidy(drop_comments(css_tokens(src)))
    squeeze = lambda s: re.sub(r'\s+', '', s)
    if squeeze(''.join(t for k, t in css_tokens(src) if k == 'code')) != squeeze(out):
        raise StripError('CSS changed while stripping')
    return out


BLOCK = re.compile(r'(<(style|script)\b[^>]*>)(.*?)(</\2\s*>)', re.S | re.I)


def strip_html(src):
    parts, pos = [], 0
    for m in BLOCK.finditer(src):
        parts.append(re.sub(r'<!--.*?-->', MARK, src[pos:m.start()], flags=re.S))
        body = m.group(3)
        if body.strip():
            body = strip_css(body) if m.group(2).lower() == 'style' else strip_js(body)
            body = '\n' + body
        parts.append(m.group(1) + body + m.group(4))
        pos = m.end()
    parts.append(re.sub(r'<!--.*?-->', MARK, src[pos:], flags=re.S))
    return tidy(''.join(parts))


STRIPPERS = {'.js': strip_js, '.css': strip_css, '.html': strip_html}


def main(src_dir, dest_dir):
    if os.path.exists(dest_dir):
        sys.exit('strip-comments: %s already exists' % dest_dir)
    shutil.copytree(src_dir, dest_dir, ignore=shutil.ignore_patterns('.*'))
    for root, _, files in os.walk(dest_dir):
        for name in files:
            strip = STRIPPERS.get(os.path.splitext(name)[1].lower())
            if not strip:
                continue
            path = os.path.join(root, name)
            with open(path, encoding='utf-8') as f:
                src = f.read()
            try:
                out = strip(src)
            except StripError as e:
                shutil.rmtree(dest_dir)
                sys.exit('strip-comments: %s: %s' % (os.path.relpath(path, dest_dir), e))
            with open(path, 'w', encoding='utf-8') as f:
                f.write(out)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
