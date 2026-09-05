import { useEffect, useState } from "react";

interface KeyboardState {
  focused: boolean;
  open: boolean;
  offset: number;
  height: number;
  top: number;
}

function readKeyboardState(focused: boolean): KeyboardState {
  const viewport = window.visualViewport;
  const windowHeight = window.innerHeight;
  const viewportHeight = viewport?.height ?? windowHeight;
  const viewportTop = viewport?.offsetTop ?? 0;
  const rawOffset = Math.max(0, windowHeight - viewportHeight - viewportTop);
  const offset = rawOffset > 24 ? Math.round(rawOffset) : 0;

  return {
    focused,
    open: focused && offset > 0,
    offset,
    height: viewportHeight,
    top: viewportTop,
  };
}

export function useMobileKeyboard(): KeyboardState {
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<KeyboardState>(() => ({
    focused: false,
    open: false,
    offset: 0,
    height: window.innerHeight,
    top: 0,
  }));

  useEffect(() => {
    const root = document.documentElement;

    function update(nextFocused = focused) {
      const next = readKeyboardState(nextFocused);
      setState(next);
      root.style.setProperty("--mob-keyboard-offset", `${next.offset}px`);
      root.dataset["mobileKeyboard"] = next.open ? "open" : "closed";
    }

    function isTextEntry(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === "textarea" || tag === "input" || target.isContentEditable;
    }

    function handleFocusIn(event: FocusEvent) {
      const nextFocused = isTextEntry(event.target);
      setFocused(nextFocused);
      update(nextFocused);
    }

    function handleFocusOut() {
      window.setTimeout(() => {
        const nextFocused = isTextEntry(document.activeElement);
        setFocused(nextFocused);
        update(nextFocused);
      }, 0);
    }

    function handleViewportChange() {
      update(focused);
    }

    update(focused);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      root.style.removeProperty("--mob-keyboard-offset");
      delete root.dataset["mobileKeyboard"];
    };
  }, [focused]);

  return state;
}
