import "babel-polyfill";
import * as AWS from "aws-sdk";
import * as awslambda from "aws-lambda";
import {CodePipelineEvent, CodePipelineJob, CodePipelineS3Location} from "./CodePipelineEvent";
import {CloudFormationChangeSetConfiguration} from "./CloudFormationChangeSetConfiguration";
import {CreateChangeSetInput, Parameter, ListChangeSetsOutput} from "aws-sdk/clients/cloudformation";
import * as JSZip from "jszip";
import {CloudFormationCreateChangeSetS3Input} from "./CloudFormationCreateChangeSetS3Input";
import {Credentials} from "aws-sdk/clients/sts"

export const codepipeline = new AWS.CodePipeline();
export const s3 = new AWS.S3();
export const sts = new AWS.STS();

const debug = process.env["DEBUG"];

//noinspection JSUnusedGlobalSymbols
export function handler(event: CodePipelineEvent, context: awslambda.Context, callback: awslambda.Callback): void {
    console.log("event", JSON.stringify(event, null, 2));
    handlerAsync(event, context)
        .then(res => {
            callback(undefined, res);
        }, err => {
            console.error(JSON.stringify(err, null, 2));
            callback(err);
        });
}

async function handlerAsync(event: CodePipelineEvent, context: awslambda.Context): Promise<void> {
    const job: CodePipelineJob = event["CodePipeline.job"];

    try {
        const createChangeSetInput = getCloudformationCreateChangeSetFromJob(job);
        debug && console.log("ChangeSet Input",JSON.stringify(createChangeSetInput));

        createChangeSetInput.Configuration.TemplateURL = await resolveObjectKey(createChangeSetInput.Configuration.TemplateURL, job);
        debug && console.log("Configuration.TemplateURL", createChangeSetInput.Configuration.TemplateURL);

        const stsResult = await sts.assumeRole({
            RoleArn: createChangeSetInput.RoleArn,
            RoleSessionName: `Codepipeline-CloudFormation-ChangeSetReplace-S3`
        }).promise();
        const credentials: Credentials = stsResult.Credentials;
        const cloudformation = new AWS.CloudFormation({
            accessKeyId: credentials.AccessKeyId,
            secretAccessKey: credentials.SecretAccessKey,
            sessionToken: credentials.SessionToken
        });

        const changeSetOutput: ListChangeSetsOutput = await cloudformation.listChangeSets({
            StackName: createChangeSetInput.Configuration.StackName
        }).promise();

        const matchingChangeSet = changeSetOutput.Summaries.find(summary => summary.ChangeSetName == createChangeSetInput.Configuration.ChangeSetName);
        if (matchingChangeSet) {
            await cloudformation.deleteChangeSet({
                StackName: createChangeSetInput.Configuration.StackName,
                ChangeSetName: createChangeSetInput.Configuration.ChangeSetName
            }).promise()
        }

        await cloudformation.createChangeSet(createChangeSetInput.Configuration).promise();
        await codepipeline.putJobSuccessResult({
            jobId: job.id
        }).promise();
    }
    catch (err) {
        console.error("An Error occurred running ChangeSetReplace S3",err);
        await codepipeline.putJobFailureResult({
            jobId: job.id,
            failureDetails: {
                type: "JobFailed",
                message: err.message,
                externalExecutionId: context.awsRequestId
            }
        }).promise();
        return;
    }
}

export function getCloudformationCreateChangeSetFromJob(job: CodePipelineJob): CloudFormationCreateChangeSetS3Input {
    const input = JSON.parse(job.data.actionConfiguration.configuration.UserParameters) as CloudFormationCreateChangeSetS3Input;
    const configuration = input.Configuration;
    const parameterOverrides = configuration.ParameterOverrides;

    debug && console.log("parameterOverrrides",parameterOverrides);

    configuration.Parameters = [];
    if (parameterOverrides) {
        delete configuration.ParameterOverrides;

        for (let key in parameterOverrides) {
            configuration.Parameters.push({
                ParameterKey: key,
                ParameterValue: parameterOverrides[key]
            });
        }
    }

    debug && console.log("process.env", process.env);
    for (let env in process.env) {
        if (env.startsWith("Param_")) {
            configuration.Parameters.push({
                ParameterKey: env.replace("Param_",""),
                ParameterValue: process.env[env]
            });
        }
    }

    return input;
}

export function getS3LocationForInputArtifact(artifactName: string, job:CodePipelineJob): CodePipelineS3Location {
    const artifact = job.data.inputArtifacts.find((artifact) => artifact.name == artifactName);

    debug && console.log("artifactName",artifactName,"artifact",artifact);

    if (artifact) {
        return artifact.location.s3Location
    }
    return null;
}

export async function resolveObjectKey(objectKey: string, job: CodePipelineJob): Promise<string> {
    debug && console.log("resolveObjectKey", objectKey);
    const matches = objectKey.match(/\${([^:]+)::([^}:]+)(::([^}]+))?}/);
    if (matches) {
        const artifactName = matches[1];
        const fileName = matches[2];
        const jsonKey = matches[4];

        const s3Location = getS3LocationForInputArtifact(artifactName, job);
        if (! s3Location) {
            throw new Error(`Invalid resource for key '${objectKey}'`);
        }

        const fileBody = await getBodyFromZippedS3Object(s3Location.bucketName, s3Location.objectKey, fileName);
        if (! fileBody) {
            throw new Error(`Invalid resource for key '${objectKey}'`);
        }

        if (!jsonKey) {
            return fileBody.toString('utf-8');
        }

        const fileJson = JSON.parse(fileBody.toString('utf-8'));
        const value = fileJson[jsonKey];

        if (!value) {
            throw new Error (`Invalid resource for key '${objectKey}`);
        }

        return objectKey.replace(matches[0], value);
    }
    return objectKey;
}

export async function getBodyFromZippedS3Object(bucketName: string, key: string, filename: string): Promise<Buffer> {
    debug && console.log("getBodyFromZippedS3Object", bucketName, key, filename);

    const params = {
        Bucket: bucketName,
        Key: key
    };

    const s3Object = await s3.getObject(params).promise();

    const zip = new JSZip();
    await zip.loadAsync(s3Object.Body as Buffer);
    const file = zip.file(filename);

    if (!file) {
        throw new Error(`Unable to get file from artifact object. File '${filename}' was not found.`)
    }

    return await file.async('nodebuffer');
}
