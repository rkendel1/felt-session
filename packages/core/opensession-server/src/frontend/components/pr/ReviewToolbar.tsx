import type { ReactNode } from "react";
import { WS_SUMMARY_REVIEW_BAR_CLEARANCE } from "../../lib/workspace-summary-classes";

/**
 * The floating review toolbar shared by branches with and without a pull
 * request. It stays edge to edge on phone and clears the standing workspace
 * summary on wide review canvases. The sticky outer surface masks code through
 * its inset; an opaque lower mask keeps scrolled code beneath pinned file headers.
 */
export function ReviewToolbar({
  children,
  compact,
}: {
  children: ReactNode;
  compact: boolean;
}) {
  const placement = compact
    ? `sticky top-0 z-20 desktop:mb-0 desktop:ml-2 desktop:pb-2 ${WS_SUMMARY_REVIEW_BAR_CLEARANCE}`
    : "desktop:mx-2 desktop:mb-2";

  return (
    <>
      <div
        className={`relative shrink-0 bg-surface desktop:pt-2.5 ${placement}`}
      >
        <div
          className={`relative bg-surface desktop:rounded-lg desktop:border desktop:border-line ${compact ? "desktop:overflow-hidden" : "desktop:overflow-visible"}`}
        >
          {children}
        </div>
      </div>
      {compact && (
        // File headers pin 61px below the scroll edge. Fill everything between
        // the toolbar and that edge so code cannot scroll above its own header.
        <div
          className="pointer-events-none sticky top-[52px] z-[5] mx-2 hidden h-2.5 -mb-2.5 overflow-clip rounded-t-lg bg-surface desktop:block"
          aria-hidden="true"
        />
      )}
    </>
  );
}
