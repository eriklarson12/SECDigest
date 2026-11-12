export interface JumpLink {
  /** The target section's id. Part of the URL contract once shipped: never rename one. */
  id: string;
  label: string;
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center text-muted underline decoration-border underline-offset-2 transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Plain anchors to sections on the page (roadmap 16.8). A caller MUST pass only sections
 * that render on the body's first commit and never unrender, so no link is dead and the row
 * never changes after paint. Not sticky. */
export default function JumpRow({ links }: { links: JumpLink[] }) {
  if (links.length === 0) return null;
  return (
    <nav
      aria-label="On this page"
      className="mb-5 flex flex-wrap items-center gap-x-4 font-sans text-2xs print:hidden"
    >
      {links.map((link) => (
        <a key={link.id} href={`#${link.id}`} className={LINK_CLASS}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}
