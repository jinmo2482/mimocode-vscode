export function renderMarkdown(text: string): string {
    // Extract fenced code blocks and inline code before HTML escaping,
    // so their content is not mangled by later \n→<br> replacement.
    const codeBlocks: string[] = [];
    const inlineCodes: string[] = [];

    let html = text;

    // Fenced code blocks: capture raw content, HTML-escape it, store for later restoration
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
        const cls = lang ? ` class="language-${lang}"` : '';
        codeBlocks.push(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
        return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, (_, code: string) => {
        inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
        return `%%INLINECODE_${inlineCodes.length - 1}%%`;
    });

    // HTML-escape the rest of the text
    html = html.replace(/&/g, '&amp;');
    html = html.replace(/</g, '&lt;');
    html = html.replace(/>/g, '&gt;');

    // Inline formatting
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Unordered lists
    html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Newline to <br> (only affects non-code text)
    html = html.replace(/\n/g, '<br>');

    // Restore code blocks and inline code (already HTML-escaped)
    html = html.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i: string) => codeBlocks[parseInt(i)]);
    html = html.replace(/%%INLINECODE_(\d+)%%/g, (_, i: string) => inlineCodes[parseInt(i)]);

    return html;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
