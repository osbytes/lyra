import { DemoProvider } from '@/components/demo/DemoProvider'
import { Calls, Demo, Download, Files, Footer, Header, Hero, Privacy, Shortcuts } from '@/components/site/Sections'
import { getLatestRelease } from '@/lib/releases'

// Re-rendered at most hourly, so download links follow new releases.
export const revalidate = 3600

export default async function Home() {
  const release = await getLatestRelease()
  // The demo's sessions are dated relative to this render, and the browser reuses it.
  const renderedAt = Date.now()
  return (
    <>
      <Header />
      <main id="top">
        <Hero release={release} />
        <DemoProvider now={renderedAt}>
          <Demo />
          <Shortcuts />
          <Calls />
          <Files />
        </DemoProvider>
        <Privacy />
        <Download release={release} />
      </main>
      <Footer />
    </>
  )
}
