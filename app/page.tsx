import Modes from "../components/modes/modes";
import { SITE_TITLE } from "../src/site";

// The metadata for this route lives in app/layout.tsx: it is the root, and a page that set any of
// `openGraph`/`twitter`/`alternates` would replace the layout's whole object rather than merge.
export default function Home() {
  return (
    <>
      {/* The deck below is a map, loaded client-side: the document as served has no words in it at
          all. One heading, hidden from sight, so the page is not anonymous to a reader who never
          sees it render. */}
      <h1 className="sr-only">{SITE_TITLE}</h1>
      <Modes />
    </>
  );
}
