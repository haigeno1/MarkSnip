(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }

  root.markSnipCodeBlockUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function repeat(character, count) {
    return Array(count + 1).join(character);
  }

  // Returns a fence one character longer than any fence-like run inside the
  // code, so the code can never close its own block. CommonMark lets a closing
  // fence be indented by up to three spaces, so indented runs count too.
  function buildCodeFence(code, fenceChar) {
    const char = String(fenceChar || '`').charAt(0) || '`';
    const escapedChar = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fenceInCodeRegex = new RegExp('^ {0,3}(' + escapedChar + '{3,})', 'gm');
    let fenceSize = 3;
    let match;
    while ((match = fenceInCodeRegex.exec(String(code || '')))) {
      if (match[1].length >= fenceSize) {
        fenceSize = match[1].length + 1;
      }
    }
    return repeat(char, fenceSize);
  }

  function normalizeCodeBlockSpacing(text, maxBlankLines = 2) {
    const lines = text.split('\n');
    const normalizedLines = [];
    let blankLineCount = 0;

    lines.forEach((line) => {
      if (/^[ \t]*$/.test(line)) {
        blankLineCount += 1;
        if (blankLineCount <= maxBlankLines) {
          normalizedLines.push('');
        }
      } else {
        blankLineCount = 0;
        normalizedLines.push(line);
      }
    });

    return normalizedLines.join('\n');
  }

  function extractCodeText(node, options = {}) {
    if (options.preserveCodeFormatting) {
      return node.innerHTML.replaceAll('<br-keep></br-keep>', '<br>');
    }

    const clonedNode = node.cloneNode(true);
    clonedNode.querySelectorAll('br-keep, br').forEach((br) => {
      br.replaceWith('\n');
    });

    return normalizeCodeBlockSpacing(clonedNode.textContent || '', 2);
  }

  function detectPreLanguage(node, code, options) {
    const shouldAutoDetectLanguage = options.autoDetectCodeLanguage !== false;
    const idMatch = node.id?.match(/code-lang-(.+)/);
    if (idMatch?.length > 1) {
      return idMatch[1];
    }

    const classTokens = (node.className || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const candidates = new Set();

    classTokens.forEach((token) => {
      candidates.add(token);
      if (token.startsWith('language-')) candidates.add(token.substring(9));
      if (token.startsWith('lang-')) candidates.add(token.substring(5));
      if (token.startsWith('source-')) candidates.add(token.substring(7));
      if (token.startsWith('highlight-')) candidates.add(token.substring(10));
    });

    const hljsApi = root.hljs;
    if (hljsApi && typeof hljsApi.getLanguage === 'function') {
      for (const candidate of candidates) {
        if (candidate && hljsApi.getLanguage(candidate)) {
          return candidate;
        }
      }
    }

    if (
      shouldAutoDetectLanguage &&
      hljsApi &&
      typeof hljsApi.highlightAuto === 'function' &&
      code.trim()
    ) {
      try {
        const detected = hljsApi.highlightAuto(code);
        if (
          detected?.language &&
          typeof detected.relevance === 'number' &&
          detected.relevance >= 2
        ) {
          return detected.language;
        }
      } catch {
        return '';
      }
    }

    return '';
  }

  function convertToFencedCodeBlock(node, options) {
    const code = extractCodeText(node, options);
    const language = detectPreLanguage(node, code, options);

    const fence = buildCodeFence(code, options.fence.charAt(0));

    return (
      '\n\n' + fence + language + '\n' +
      code.replace(/\n$/, '') +
      '\n' + fence + '\n\n'
    );
  }

  return {
    repeat,
    buildCodeFence,
    normalizeCodeBlockSpacing,
    extractCodeText,
    convertToFencedCodeBlock
  };
});
