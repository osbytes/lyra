import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extensions'

export type NotesHandle = {
  /** Adds a block (markdown) at the end of the notes, as the user's own undoable edit. */
  append: (markdown: string) => void
  focus: () => void
}

type Props = {
  /** The notes as markdown: what the session document and the export hold. */
  value: string
  onChange: (value: string) => void
  placeholder: string
  ref?: Ref<NotesHandle>
}

/**
 * The session's free-text notes, as a rich-text editor over markdown. The document keeps plain
 * markdown, so the `.md`/`.txt` export reads the same in any other editor. The editor owns its
 * own undo history; text arriving from elsewhere (another window) replaces the content only
 * when it differs from what this editor last wrote, so typing never fights its own echo.
 */
export function NotesEditor({ value, onChange, placeholder, ref }: Props) {
  const written = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Markdown,
      Placeholder.configure({ placeholder })
    ],
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'notes-editor', 'aria-label': 'Notes', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown()
      written.current = markdown
      onChangeRef.current(markdown)
    }
  })

  useEffect(() => {
    if (value === written.current) return
    written.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  useImperativeHandle(
    ref,
    () => ({
      append: (markdown) => {
        editor
          .chain()
          .insertContentAt(editor.state.doc.content.size, markdown, { contentType: 'markdown' })
          .scrollIntoView()
          .run()
      },
      focus: () => {
        editor.commands.focus('end')
      }
    }),
    [editor]
  )

  return <EditorContent editor={editor} className="notes-field" />
}
