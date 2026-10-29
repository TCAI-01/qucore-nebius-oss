// Monaco is bundled with the app (no CDN, works offline). Only the editor core and syntax colouring for common
// languages are included (no language-service workers), which is all a diff viewer needs and keeps the build light.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new editorWorker() }
loader.config({ monaco })

export default monaco
