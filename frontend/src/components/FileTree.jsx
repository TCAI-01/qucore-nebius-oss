import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react'

export function collectFiles(node, out = []) {
  if (node.type === 'dir') node.children.forEach(child => collectFiles(child, out))
  else if (!node.reason) out.push(node.path)
  return out
}

export function Checkbox({ mixed = false, ...props }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-checked={mixed ? 'mixed' : props.checked} {...props} />
}

function Node({ node, depth = 0, selected, selectPaths, activePath, onOpen, readOnly = false }) {
  const [open, setOpen] = useState(depth < 1)
  const folder = node.type === 'dir'
  const paths = folder ? collectFiles(node) : [node.path]
  const count = paths.filter(path => selected.has(path)).length
  const all = paths.length > 0 && count === paths.length
  return <div>
    <div className={`tree-row ${node.path === activePath ? 'bg-accent-dim' : ''}`} style={{ paddingLeft: depth * 14 + 10 }}>
      {folder ? <button className="shrink-0" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="w-[13px] shrink-0" />}
      {!readOnly && <Checkbox checked={all} mixed={count > 0 && !all} disabled={folder ? !paths.length : Boolean(node.reason)}
        aria-label={`Select ${node.path}`} onChange={() => selectPaths(paths, !all)} />}
      <button title={node.reason || node.path} disabled={!folder && Boolean(node.reason)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-40"
        onClick={() => folder ? setOpen(!open) : onOpen(node.path)}>
        {folder ? (open ? <FolderOpen size={15} className="text-sky-400 shrink-0" /> : <Folder size={15} className="text-sky-400 shrink-0" />) : <FileCode2 size={14} className="text-muted shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {folder && count > 0 && <span className="text-[10px] text-sky-400">{count}</span>}
      {!folder && node.reason && <span className="text-[9px] text-muted" title={node.reason}>excluded</span>}
    </div>
    {folder && open && node.children.map(child => <Node key={child.path} node={child} depth={depth + 1} selected={selected} selectPaths={selectPaths} activePath={activePath} onOpen={onOpen} readOnly={readOnly} />)}
  </div>
}

export default function FileTree(props) {
  return <div className="py-2">{props.tree.children.map(node => <Node key={node.path} node={node} {...props} />)}</div>
}
