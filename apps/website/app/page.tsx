import { AppShot, Download, Footer, Header, Hero } from '@/components/site/Sections'
import { getLatestRelease } from '@/lib/releases'

// Re-rendered at most hourly, so download links follow new releases.
export const revalidate = 3600

export default async function Home() {
  const release = await getLatestRelease()
  return (
    <>
      <Header />
      <main id="top">
        <Hero release={release} />
        <AppShot />
        <Download release={release} />
      </main>
      <Footer />
    </>
  )
}
