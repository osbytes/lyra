import { ImageResponse } from 'next/og'

export const alt = 'Lyra: talk, meet, think out loud. Lyra writes it all down.'
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
        <div style={{ display: 'flex', flexDirection: 'column', fontSize: 92, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>
          <div style={{ display: 'flex' }}>Talk, meet, think out loud.</div>
          <div style={{ display: 'flex' }}>
            Lyra&nbsp;<span style={{ color: '#4338ca', fontStyle: 'italic', fontWeight: 400 }}>writes it all down</span>.
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 32, color: '#5d5d6b' }}>
          Voice notes and meeting transcripts that stay on your computer.
        </div>
      </div>
    </div>,
    size
  )
}
