import { ArrowUpRight, Code2, Scissors } from 'lucide-react';
import Link from 'next/link';
import Editor from '@/components/editor/Editor';
import { SOURCE_URL } from '@/lib/site/links';

// The page is a static shell; everything happens in the browser.
export const dynamic = 'force-static';

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-icon">
            <Scissors size={22} />
          </span>
          cutout<span className="brand-dot">.</span>
        </Link>
        <a className="source" href={SOURCE_URL} target="_blank" rel="noreferrer">
          <Code2 size={18} /> GitHub <ArrowUpRight size={15} />
        </a>
      </header>
      <section className="intro">
        <div>
          <div className="eyebrow">A LITTLE LESS BACKGROUND.</div>
          <h1>
            Background remover.
            <br />
            <span>For free!</span>
          </h1>
        </div>
        <p>
          No login. No watermark.
          <br />
          Just your image, cut out.
        </p>
      </section>
      <Editor />
      <footer>
        <span>
          <span className="status-dot" /> Free. Open source. Yours.
        </span>
        <span>Made for the image. Nothing else.</span>
      </footer>
    </main>
  );
}
