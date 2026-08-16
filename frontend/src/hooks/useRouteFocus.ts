import { useEffect, useRef, type RefObject } from "react";
import { useLocation } from "react-router";

/**
 * Move focus to the new page when the route changes.
 *
 * An SPA swaps the document body without a page load, so a screen reader is
 * told nothing: the skip link exists, but after following a nav link the
 * virtual cursor and the tab order both stay parked in the masthead, and the
 * reader has no signal that the record in front of them changed. Focus
 * movement fixes both at once, which an aria-live announcer would not — an
 * announcer speaks the new page name but leaves a keyboard user's next Tab
 * back in the nav they just left.
 *
 * We aim at the page `<h1>`, because the accessible name announced on focus is
 * then the page's own name ("Votes"), which is the closest thing this app has
 * to the title a full page load would have read out. It is found by query
 * rather than by ref so that a page does not have to register itself with the
 * shell to be navigable.
 *
 * The `<main>` element is the fallback, and it is a real case rather than
 * defensive padding: `OfficialPage` and `MeetingDetailPage` derive their `<h1>`
 * from fetched data, so at the instant the route changes there is no heading in
 * the tree yet. Landing on the main landmark still moves the reader out of the
 * masthead and into the new page.
 *
 * Nothing happens on first render. A fresh page load already puts the reader at
 * the top of the document, and stealing focus there would be a change the
 * reader did not ask for.
 */
export function useRouteFocus(mainRef: RefObject<HTMLElement>): void {
  const { pathname } = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const main = mainRef.current;
    if (!main) return;

    // Keyed on pathname only, so following the "Skip to content" link — which
    // moves the hash and nothing else — does not re-trigger this and fight the
    // browser for the focus the reader just placed deliberately.
    const target = main.querySelector("h1") ?? main;

    // An <h1> is not focusable on its own. tabIndex -1 makes it a programmatic
    // focus target without inserting it into the tab order, so a keyboard user
    // tabbing through the page never lands on a heading.
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus();
  }, [pathname, mainRef]);
}
