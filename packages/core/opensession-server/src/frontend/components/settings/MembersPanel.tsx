import { useState } from "react";
import { defaultWorkspaceModelSettings } from "../../lib/api";
import { modelRoleAssignment, ROLE_DESCRIPTIONS } from "../../lib/agent-roles";
import { BASE_PATH } from "../../lib/base";
import type { Workspace } from "../../lib/types";
import { Button } from "../../ui/button";
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
import { WorkspaceModelPresets } from "../WorkspaceModelPresets";

// Workspace → Members: the identity table, on a page of its own. Commit
// attribution, `allowedUsers` scoping and GitHub sign-in all resolve through
// it, so it long outlives the Setup wizard step that first fills it in.

export function MembersPanel({ workspace }: { workspace?: Workspace }) {
	const [configureRoles, setConfigureRoles] = useState(false);
	const presets = workspace?.modelSettings?.presets
		|| defaultWorkspaceModelSettings()?.presets
		|| [];
	const roles = presets.filter((preset) => preset.group === "roles");
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
				Type @ in a conversation or new workspace to choose one. Assign each role
				to any model available through your configured providers.
			</p>
			<SettingCard>
				{roles.map((role) => {
					const assignment = modelRoleAssignment(role.lead.model);
					return (
						<SettingRow key={role.id} className="items-start gap-x-3">
							<IconTile name={assignment.icon} size={28} />
							<SettingRowText>
								<SettingRowTitle>{role.label}</SettingRowTitle>
								<SettingRowDescription>
									{ROLE_DESCRIPTIONS[role.id] || role.instructions || "Workspace agent role."}
									<span className="mt-0.5 block text-fg-muted">{assignment.label}</span>
								</SettingRowDescription>
							</SettingRowText>
						</SettingRow>
					);
				})}
			</SettingCard>
			<Button className="w-fit" disabled={!workspace} onClick={() => setConfigureRoles(true)}>
				Configure roles
			</Button>
			{workspace && (
				<WorkspaceModelPresets
					workspace={workspace}
					open={configureRoles}
					onOpenChange={setConfigureRoles}
					onSaved={() => window.dispatchEvent(new Event("opensession:workspaces-changed"))}
				/>
			)}
		</SettingsPanel>
	);
}
