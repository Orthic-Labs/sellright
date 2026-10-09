import { useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Bold, Code2, Heading2, Heading3, Image as ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, Quote, Redo2, Undo2 } from 'lucide-react';
import { blogExtensions, htmlOut, normalizeUrl } from './blog-editor-core';
import './blog-editor.css';

interface Props {
  /** Initial HTML. The editor is uncontrolled after mount; remount (key) to load another post. */
  value: string;
  onChange: (html: string) => void;
}

type UrlMode = 'link' | 'image' | null;

function Btn({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors disabled:opacity-40 ${active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
      {children}
    </button>
  );
}

/**
 * Rich-text editor for blog bodies. Stored format is HTML (API sanitises on
 * write). The original HTML is passed through untouched until the author makes
 * an edit, so merely opening and re-saving a post never rewrites it.
 */
export default function BlogEditor({ value, onChange }: Props) {
  const [source, setSource] = useState(false);
  const [html, setHtml] = useState(value);
  const [urlMode, setUrlMode] = useState<UrlMode>(null);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');

  const editor = useEditor({
    extensions: blogExtensions(),
    content: value,
    editorProps: { attributes: { 'aria-label': 'Post body', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor: ed }) => { const out = htmlOut(ed); setHtml(out); onChange(out); },
  });

  const st = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      h2: !!ed?.isActive('heading', { level: 2 }), h3: !!ed?.isActive('heading', { level: 3 }),
      bold: !!ed?.isActive('bold'), italic: !!ed?.isActive('italic'), link: !!ed?.isActive('link'),
      ul: !!ed?.isActive('bulletList'), ol: !!ed?.isActive('orderedList'), quote: !!ed?.isActive('blockquote'),
      canUndo: !!ed?.can().undo(), canRedo: !!ed?.can().redo(), linkHref: (ed?.getAttributes('link').href as string | undefined) ?? '',
    }),
  });

  if (!editor || !st) return <div className="min-h-[280px]" />;
  const chain = () => editor.chain().focus();

  const openUrl = (mode: Exclude<UrlMode, null>) => {
    setUrl(mode === 'link' ? st.linkHref : ''); setUrlError(''); setUrlMode(mode);
  };
  const applyUrl = () => {
    if (urlMode === 'link' && !url.trim()) { chain().extendMarkRange('link').unsetLink().run(); setUrlMode(null); return; }
    const clean = normalizeUrl(url, urlMode === 'link');
    if (!clean) { setUrlError(urlMode === 'image' ? 'Enter a full http(s) image URL.' : 'Enter a full http(s) or mailto URL.'); return; }
    if (urlMode === 'link') chain().extendMarkRange('link').setLink({ href: clean }).run();
    else chain().setImage({ src: clean }).run();
    setUrlMode(null);
  };

  const toggleSource = () => {
    if (source) editor.commands.setContent(html, { emitUpdate: false });
    setSource(!source);
  };

  return (
    <div className="blog-editor rounded-lg border border-line-strong bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/35">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1" role="toolbar" aria-label="Formatting">
        {!source && <>
          <Btn label="Heading 2" active={st.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></Btn>
          <Btn label="Heading 3" active={st.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></Btn>
          <Btn label="Bold" active={st.bold} onClick={() => chain().toggleBold().run()}><Bold size={16} /></Btn>
          <Btn label="Italic" active={st.italic} onClick={() => chain().toggleItalic().run()}><Italic size={16} /></Btn>
          <Btn label="Link" active={st.link} onClick={() => openUrl('link')}><LinkIcon size={16} /></Btn>
          <Btn label="Bulleted list" active={st.ul} onClick={() => chain().toggleBulletList().run()}><List size={16} /></Btn>
          <Btn label="Numbered list" active={st.ol} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={16} /></Btn>
          <Btn label="Blockquote" active={st.quote} onClick={() => chain().toggleBlockquote().run()}><Quote size={16} /></Btn>
          <Btn label="Image by URL" onClick={() => openUrl('image')}><ImageIcon size={16} /></Btn>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <Btn label="Undo" disabled={!st.canUndo} onClick={() => chain().undo().run()}><Undo2 size={16} /></Btn>
          <Btn label="Redo" disabled={!st.canRedo} onClick={() => chain().redo().run()}><Redo2 size={16} /></Btn>
        </>}
        <span className="ml-auto" />
        <Btn label={source ? 'Back to visual editor' : 'Edit HTML source'} active={source} onClick={toggleSource}><Code2 size={16} /></Btn>
      </div>

      {urlMode && !source && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
          <input autoFocus className="input !w-auto min-w-[220px] flex-1" type="url" placeholder={urlMode === 'image' ? 'https://…/image.jpg' : 'https://…'}
            aria-label={urlMode === 'image' ? 'Image URL' : 'Link URL'} value={url}
            onChange={(e) => { setUrl(e.target.value); setUrlError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } if (e.key === 'Escape') setUrlMode(null); }} />
          <button type="button" className="btn-primary" onClick={applyUrl}>{urlMode === 'image' ? 'Insert' : 'Apply'}</button>
          <button type="button" className="btn-ghost" onClick={() => setUrlMode(null)}>Cancel</button>
          {urlError && <span role="alert" className="w-full text-xs text-danger">{urlError}</span>}
        </div>
      )}

      {source
        ? <textarea className="block w-full min-h-[240px] resize-y bg-transparent p-3 font-mono text-sm outline-none" aria-label="Post body HTML" value={html}
            onChange={(e) => { setHtml(e.target.value); onChange(e.target.value); }} />
        : <EditorContent editor={editor} />}
    </div>
  );
}
