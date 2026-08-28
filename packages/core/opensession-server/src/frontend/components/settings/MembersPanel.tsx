import { BASE_PATH } from "../../lib/base";
import {
	SettingCard,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsPanel,
} from "../../ui/settings";
import { IconTile } from "../BrandTile";
import { TeamSection } from "../SetupTeam";

const AGENT_ROLES = [
	["Architect", "Plans architecture and evaluates technical risk.", "claude"],
	["Researcher", "Investigates questions and returns sourced findings.", "codex"],
	["Planner", "Turns outcomes and constraints into an actionable plan.", "claude"],
	["Coder", "Implements and tests changes with local Ollama.", "ollama"],
	["Reviewer", "Reviews diffs independently before release.", "codex"],
	["Tester", "Reproduces behavior and verifies edge cases.", "ollama"],
	["Release", "Verifies and promotes tested revisions.", "codex"],
	["GitHub agent", "Handles issues, pull requests, reviews, and checks.", "github"],
] as const;

// Workspace → Members: the identity table, on a page of its own. Commit
// attribution, `allowedUsers` scoping and GitHub sign-in all resolve through
// it, so it long outlives the Setup wizard step that first fills it in.

export function MembersPanel() {
	return (
		<SettingsPanel>
			<SettingsHeader
				title="Members"
				description={
					<>
						Members identify who sessions act as. Configure who can sign in under{" "}
						<a
							href={`${BASE_PATH}/settings/authentication`}
							className="text-link hover:underline"
						>
							Authentication
						</a>
						.
					</>
				}
			/>
			<TeamSection onChanged={() => {}} />
			<SettingsGroupLabel>Agent roles</SettingsGroupLabel>
			<p className="mb-2 text-label text-dim">
				Type @ in a conversation or new workspace to choose one. Agent roles are
				separate from people and do not need sign-in accounts.
			</p>
			<SettingCard>
				{AGENT_ROLES.map(([name, description, icon]) => (
					<SettingRow key={name} className="items-start gap-x-3">
						<IconTile name={icon} size={28} />
						<SettingRowText>
							<SettingRowTitle>{name}</SettingRowTitle>
							<SettingRowDescription>{description}</SettingRowDescription>
						</SettingRowText>
					</SettingRow>
				))}
			</SettingCard>
		</SettingsPanel>
	);
}
