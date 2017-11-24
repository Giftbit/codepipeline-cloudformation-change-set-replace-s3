import {CloudFormationChangeSetConfiguration} from "./CloudFormationChangeSetConfiguration";

export interface CloudFormationCreateChangeSetS3Input {
    RoleArn: string;
    Configuration: CloudFormationChangeSetConfiguration
}