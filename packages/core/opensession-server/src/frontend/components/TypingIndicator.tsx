import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	textFaint: { color: "var(--text-faint)" },
});
import { typingLabel } from "../lib/typing";

export function TypingIndicator({
	users,
	className,
}: {
	users: string[];
	className?: string;
}) {
	const label = typingLabel(users);
	if (!label) return null;
	const rootStyles = stylex.props(typography.label, sx.textFaint);
	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className={[rootStyles.className, className].filter(Boolean).join(" ")}
			style={rootStyles.style}
		>
			{label}
		</div>
	);
}
