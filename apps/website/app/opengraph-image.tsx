import { ImageResponse } from 'next/og'

export const alt = 'Lyra: talk onto pages.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpenGraphImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: '72px 80px',
        background: '#f7f7fa',
        color: '#18181f'
      }}
    >
      <div style={{ display: 'flex', fontSize: 36, fontWeight: 600 }}>Lyra</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', fontSize: 132, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>
          Talk onto&nbsp;<span style={{ color: '#4338ca', fontStyle: 'italic', fontWeight: 400 }}>pages</span>.
        </div>
        <div style={{ display: 'flex', fontSize: 32, color: '#5d5d6b' }}>
          A voice notebook that stays on your computer.
        </div>
      </div>
    </div>,
    size
  )
}
