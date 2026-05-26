// Strip markdown formatting for plain-text consumers (TTS, clipboard, etc.).
// Ported verbatim from text-reader-extension/popup.js stripMarkdown.

function stripMarkdown(text) {
    if (!text) return '';
    let s = text;
    // Fenced code blocks — keep content
    s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');
    // Inline code
    s = s.replace(/`([^`\n]+)`/g, '$1');
    // Images: ![alt](url) -> alt
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Links: [text](url) -> text
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Reference-style links: [text][ref] -> text
    s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
    // Headings
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/__(.+?)__/g, '$1');
    // Italic
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
    s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');
    // Strikethrough
    s = s.replace(/~~(.+?)~~/g, '$1');
    // Blockquote markers
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    // Unordered list markers
    s = s.replace(/^\s*[-*+]\s+/gm, '');
    // Ordered list markers
    s = s.replace(/^\s*\d+\.\s+/gm, '');
    // Horizontal rules
    s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');
    // HTML tags
    s = s.replace(/<[^>]+>/g, '');
    // Collapse 3+ blank lines
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

self.QuickBlockMarkdown = { stripMarkdown };
