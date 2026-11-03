import bishopSvg from '../assets/chess_bishop.svg?raw';

// Kenney's chess bishop (CC0). The source SVG has no viewBox; its path is centered on 0,0.
const PATH = /\sd="([^"]+)"/.exec(bishopSvg)?.[1] ?? '';

/** The Bishop chess-piece mark, filled with currentColor so it themes. */
export function BishopLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-26 -36 52 72"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d={PATH} />
    </svg>
  );
}
