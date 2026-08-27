import { expect, test } from "bun:test";

async function source(name: string) {
	return Bun.file(new URL(name, import.meta.url)).text();
}

test("the conversation model menu can make its current model the personal default", async () => {
	const picker = await source("./ModelEffortSelect.tsx");

	expect(picker).toContain("<span {...stylex.props(sx.minW0, sx.truncate)}>Set as default</span>");
	expect(picker).toContain("onClick={() => onSetAsDefault(effectiveModel)}");
	expect(picker).toContain("disabled={isPreferredDefault}");
});

test("both conversation model-menu triggers persist and reflect the personal default", async () => {
	const [composer, infoRow, preferenceHook] = await Promise.all([
		source("./Composer.tsx"),
		source("./ModelMenuRow.tsx"),
		source("../hooks/useDefaultModelPreference.ts"),
	]);

	for (const caller of [composer, infoRow]) {
		expect(caller).toContain("useDefaultModelPreference()");
		expect(caller).toContain("preferredDefaultModel={preferredDefaultModel}");
		expect(caller).toContain("onSetAsDefault={setPreferredDefaultModel}");
	}
	expect(preferenceHook).toContain("onDefaultModelPrefChanged");
	expect(preferenceHook).toContain("setPreferredDefaultModel: setDefaultModelPref");
});
