import Modes from "../components/modes/modes";
import { SITE_TITLE } from "../src/site";

// No metadata here: setting `openGraph` or `alternates` would replace the layout's, not merge.
export default function Home() {
  return (
    <>
      {/* The deck is client-rendered, so without this the served document has no heading. */}
      <h1 className="sr-only">{SITE_TITLE}</h1>
      <Modes />
    </>
  );
}
