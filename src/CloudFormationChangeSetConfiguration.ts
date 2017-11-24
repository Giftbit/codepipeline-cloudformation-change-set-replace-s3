import {CreateChangeSetInput} from "aws-sdk/clients/cloudformation";

export interface CloudFormationChangeSetConfiguration extends CreateChangeSetInput {
    ParameterOverrides?: { [key: string]: string };
}
