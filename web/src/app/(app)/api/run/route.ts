import { parseDataSafe } from "../../../../lib/parseDataSafe";
import { createRun } from "../../../../server/createRun";
import { db } from "@/db/db";
import { deploymentsTable } from "@/db/schema";
import { isKeyRevoked } from "@/server/curdApiKeys";
import { getRunsData } from "@/server/getRunsOutput";
import { parseJWT } from "@/server/parseJWT";
import { replaceCDNUrl } from "@/server/replaceCDNUrl";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Request = z.object({
  deployment_id: z.string(),
  inputs: z.record(z.string()).optional(),
});

const Request2 = z.object({
  run_id: z.string(),
});

async function checkToken(request: Request) {
  const token = request.headers.get("Authorization")?.split(" ")?.[1]; // Assuming token is sent as "Bearer your_token"
  const userData = token ? parseJWT(token) : undefined;
  if (!userData || token === undefined) {
    return {
      error: new NextResponse("Invalid or expired token", {
        status: 401,
      }),
    };
  } else {
    const revokedKey = await isKeyRevoked(token);
    if (revokedKey)
      return {
        error: new NextResponse("Revoked token", {
          status: 401,
        }),
      };
  }

  return {
    data: userData,
  };
}

export async function GET(request: Request) {
  const apiKeyTokenData = await checkToken(request);
  if (apiKeyTokenData.error) return apiKeyTokenData.error;

  const [data, error] = await parseDataSafe(Request2, request);
  if (!data || error) return error;

  // return NextResponse.json(
  //   await db
  //     .select()
  //     .from(workflowTable)
  //     .innerJoin(
  //       workflowRunsTable,
  //       eq(workflowTable.id, workflowRunsTable.workflow_id)
  //     )
  //     .where(
  //       and(
  //         eq(workflowTable.id, workflowRunsTable.workflow_id),
  //         apiKeyTokenData.data.org_id
  //           ? eq(workflowTable.org_id, apiKeyTokenData.data.org_id)
  //           : eq(workflowTable.user_id, apiKeyTokenData.data.user_id!)
  //       )
  //     ),
  //   {
  //     status: 200,
  //   }
  // );

  const run = await getRunsData(apiKeyTokenData.data, data.run_id);

  if (!run) return new NextResponse("Run not found", { status: 404 });

  if (run?.status === "success" && run?.outputs?.length > 0) {
    for (let i = 0; i < run.outputs.length; i++) {
      const output = run.outputs[i];

      if (output.data?.images !== undefined) {
        for (let j = 0; j < output.data?.images.length; j++) {
          const element = output.data?.images[j];
          element.url = replaceCDNUrl(
            `${process.env.SPACES_ENDPOINT}/${process.env.SPACES_BUCKET}/outputs/runs/${run.id}/${element.filename}`
          );
        }
      } else if (output.data?.files !== undefined) {
        for (let j = 0; j < output.data?.files.length; j++) {
          const element = output.data?.files[j];
          element.url = replaceCDNUrl(
            `${process.env.SPACES_ENDPOINT}/${process.env.SPACES_BUCKET}/outputs/runs/${run.id}/${element.filename}`
          );
        }
      }
    }
  }

  return NextResponse.json(run, {
    status: 200,
  });
}

export async function POST(request: Request) {
  const apiKeyTokenData = await checkToken(request);
  if (apiKeyTokenData.error) return apiKeyTokenData.error;

  const [data, error] = await parseDataSafe(Request, request);
  if (!data || error) return error;

  const origin = new URL(request.url).origin;

  const { deployment_id, inputs } = data;

  try {
    const deploymentData = await db.query.deploymentsTable.findFirst({
      where: eq(deploymentsTable.id, deployment_id),
      with: {
        machine: true,
        version: {
          with: {
            workflow: {
              columns: {
                org_id: true,
                user_id: true,
              },
            },
          },
        },
      },
    });

    if (!deploymentData) throw new Error("Deployment not found");

    const run_id = await createRun({
      origin,
      workflow_version_id: deploymentData.version,
      machine_id: deploymentData.machine,
      inputs,
      isManualRun: false,
      apiUser: apiKeyTokenData.data,
    });

    if ("error" in run_id) throw new Error(run_id.error);

    return NextResponse.json(
      {
        run_id: "workflow_run_id" in run_id ? run_id.workflow_run_id : "",
      },
      {
        status: 200,
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message,
      },
      {
        status: 500,
      }
    );
  }
}
