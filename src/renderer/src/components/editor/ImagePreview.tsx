import { useEffect, useState } from 'react'

interface Props {
  id: string
  name: string
}

/** 图片文件预览（替代 Monaco）。经 window.api.fs.readImage 取 dataURL。 */
export default function ImagePreview({ id, name }: Props) {
  const [src, setSrc] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setErr('')
    setSrc('')
    window.api.fs
      .readImage(id)
      .then((u) => {
        if (alive) setSrc(u)
      })
      .catch((e) => {
        if (alive) {
          setSrc('')
          setErr((e as Error).message)
        }
      })
    return () => {
      alive = false
    }
  }, [id])

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ink-2)',
      }}
    >
      {err ? (
        <div style={{ opacity: 0.7 }}>图片预览失败：{err}</div>
      ) : src ? (
        <img src={src} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      ) : (
        <div style={{ opacity: 0.6 }}>加载图片…</div>
      )}
    </div>
  )
}
