/**
 * The Maranics brandmark, in the file drawn for the ground it sits on: navy gear + cyan pixels on light,
 * white gear + cyan pixels on dark (the theme swaps them in CSS, see `.logo-light` / `.logo-dark`).
 * `mark` = the symbol alone (tight places: the phone bar, the splash); otherwise the full logotype.
 * Never mirrored, stretched or recoloured; clear space is a third of its height.
 */
export function Logo({ mark = false, height = 22, className = "", title = "Maranics" }: { mark?: boolean; height?: number; className?: string; title?: string }) {
	const ratio = mark ? 92.93 / 77.54 : 288.68 / 65.25;
	const width = Math.round(height * ratio);
	const light = mark ? "/mark.svg" : "/logo.svg";
	const dark = mark ? "/mark-on-dark.svg" : "/logo-on-dark.svg";
	return (
		<span className={`inline-flex shrink-0 items-center ${className}`} style={{ height, width }} role="img" aria-label={title}>
			<img src={light} height={height} width={width} alt="" className="logo-light" draggable={false} />
			<img src={dark} height={height} width={width} alt="" className="logo-dark" draggable={false} />
		</span>
	);
}
