import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { publishReport, REPORTS_ROOT } from "../reports";
import { handleReportsRoutes } from "./reports";

const automationId = `test-report-assets-route-${process.pid}`;

afterEach(() => {
	rmSync(join(REPORTS_ROOT, automationId), { recursive: true, force: true });
});

describe("report asset routes", () => {
	test("serves a published asset with its content type", async () => {
		const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
		const report = publishReport({
			automationId,
			automationName: "Test",
			title: "Asset report",
			html: '<img src="assets/evidence/frame.jpg">',
			assets: [{ path: "evidence/frame.jpg", data }],
		});
		const path = `/backstage/api/reports/${automationId}/${report.id}/assets/evidence/frame.jpg`;
		const url = new URL(`http://localhost${path}`);

		const response = await handleReportsRoutes({
			req: new Request(url),
			url,
			path,
			publicPrefix: "/backstage",
		});

		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("image/jpeg");
		expect(response?.headers.get("content-security-policy")).toBe("sandbox");
		expect(Buffer.from(await response!.arrayBuffer())).toEqual(data);
	});
});
