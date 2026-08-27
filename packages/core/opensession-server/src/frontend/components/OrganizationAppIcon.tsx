import React, { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
	DEFAULT_APP_ICON_URL,
	useOrganizationIcon,
} from "../hooks/useOrganizationIcon";
import { mergeStylexProps } from "../ui/cn";

const sx = stylex.create({
	block: { display: "block" },
	size11: { width: "44px", height: "44px" },
	roundedControl: { borderRadius: "var(--radius-control)" ,
		cornerShape: "var(--cs)"},
	objectCover: { objectFit: "cover" },
});

/** The organization mark when configured, with the bundled app mark as fallback. */
export function OrganizationAppIcon({ className }: { className?: string }) {
	const configuredSrc = useOrganizationIcon();
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const usesOrganizationIcon =
		configuredSrc !== DEFAULT_APP_ICON_URL && failedSrc !== configuredSrc;
	const src = usesOrganizationIcon ? configuredSrc : DEFAULT_APP_ICON_URL;

	return (
		<img
			{...mergeStylexProps(className, sx.block, sx.size11, usesOrganizationIcon && sx.roundedControl, usesOrganizationIcon && sx.objectCover)}
			src={src}
			alt=""
			onError={() => {
				if (src !== DEFAULT_APP_ICON_URL) setFailedSrc(src);
			}}
		/>
	);
}
