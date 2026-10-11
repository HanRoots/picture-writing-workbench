import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export default function AnnotatedText({ text, annotations = [] }) {
  const [active, setActive] = useState(null);
  const [popoverStyle, setPopoverStyle] = useState(null);
  const rootRef = useRef(null);
  const popoverRef = useRef(null);
  const segments = useMemo(() => {
    const safe = [...annotations]
      .filter((item) => Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end <= text.length && item.end > item.start)
      .sort((a, b) => a.start - b.start);
    const output = [];
    let cursor = 0;
    safe.forEach((annotation) => {
      const start = Math.max(cursor, annotation.start);
      if (start > cursor) output.push({ text: text.slice(cursor, start) });
      if (annotation.end > start) output.push({ text: text.slice(start, annotation.end), annotation });
      cursor = Math.max(cursor, annotation.end);
    });
    if (cursor < text.length) output.push({ text: text.slice(cursor) });
    return output;
  }, [text, annotations]);

  useLayoutEffect(() => {
    if (!active || !rootRef.current || !popoverRef.current) return undefined;
    const root = rootRef.current;
    const popover = popoverRef.current;
    const mark = root.querySelector('[data-annotation-active="true"]');
    const scrollArea = root.closest('.source-scroll');
    if (!mark || !scrollArea) return undefined;

    const updatePosition = () => {
      const markRect = mark.getBoundingClientRect();
      const wrapperRect = mark.parentElement.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const boundaryRect = scrollArea.getBoundingClientRect();
      const margin = 12;
      const markCenter = markRect.left + markRect.width / 2;
      const minCenter = boundaryRect.left + margin + popoverRect.width / 2;
      const maxCenter = boundaryRect.right - margin - popoverRect.width / 2;
      const popoverCenter = Math.min(Math.max(markCenter, minCenter), Math.max(minCenter, maxCenter));
      const popoverLeftEdge = popoverCenter - popoverRect.width / 2;
      const arrowLeft = Math.min(
        Math.max(markCenter - popoverLeftEdge - 5, 10),
        popoverRect.width - 20,
      );
      setPopoverStyle({
        left: `${popoverCenter - wrapperRect.left}px`,
        '--annotation-arrow-left': `${arrowLeft}px`,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    scrollArea.addEventListener('scroll', updatePosition, { passive: true });
    return () => {
      window.removeEventListener('resize', updatePosition);
      scrollArea.removeEventListener('scroll', updatePosition);
    };
  }, [active]);

  return (
    <div className="annotated-text" ref={rootRef}>
      {segments.map((segment, index) => segment.annotation ? (
        <span className="annotation-wrap" key={`${segment.annotation.id}-${index}`}>
          <button
            className={`annotation-mark ${segment.annotation.tone === 'positive' ? 'positive' : segment.annotation.tone === 'neutral' ? 'neutral' : segment.annotation.repeated ? 'issue repeated' : 'issue'}`}
            data-annotation-active={active === segment.annotation.id}
            aria-expanded={active === segment.annotation.id}
            onClick={() => {
              setPopoverStyle(null);
              setActive(active === segment.annotation.id ? null : segment.annotation.id);
            }}
          >{segment.text}</button>
          {active === segment.annotation.id && (
            <span
              className={`annotation-popover ${segment.annotation.tone === 'neutral' ? 'neutral' : ''}`}
              ref={popoverRef}
              role="tooltip"
              style={popoverStyle || undefined}
            >
              <strong>{segment.annotation.type}</strong>
              <span>{segment.annotation.reason}</span>
            </span>
          )}
        </span>
      ) : <span key={`plain-${index}`}>{segment.text}</span>)}
    </div>
  );
}
