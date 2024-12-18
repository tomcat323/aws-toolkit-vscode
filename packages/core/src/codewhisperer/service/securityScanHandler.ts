/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultCodeWhispererClient } from '../client/codewhisperer'
import { getLogger } from '../../shared/logger'
import * as vscode from 'vscode'
import {
    AggregatedCodeScanIssue,
    CodeScanIssue,
    CodeScansState,
    codeScanState,
    CodeScanStoppedError,
} from '../models/model'
import { sleep } from '../../shared/utilities/timeoutUtils'
import * as codewhispererClient from '../client/codewhisperer'
import * as CodeWhispererConstants from '../models/constants'
import { existsSync, statSync, readFileSync } from 'fs' // eslint-disable-line no-restricted-imports
import { RawCodeScanIssue } from '../models/model'
import * as crypto from 'crypto'
import path = require('path')
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import {
    ArtifactMap,
    CreateUploadUrlRequest,
    CreateUploadUrlResponse,
    UploadIntent,
} from '../client/codewhispereruserclient'
import { TelemetryHelper } from '../util/telemetryHelper'
import request from '../../shared/request'
import { ZipMetadata } from '../util/zipUtil'
import { getNullLogger } from '../../shared/logger/logger'
import {
    CreateCodeScanError,
    CreateUploadUrlError,
    InvalidSourceZipError,
    SecurityScanTimedOutError,
    UploadArtifactToS3Error,
} from '../models/errors'
import { getTelemetryReasonDesc } from '../../shared/errors'

export async function listScanResults(
    client: DefaultCodeWhispererClient,
    jobId: string,
    codeScanFindingsSchema: string,
    projectPaths: string[],
    scope: CodeWhispererConstants.CodeAnalysisScope,
    editor: vscode.TextEditor | undefined
) {
    const logger = getLoggerForScope(scope)
    const codeScanIssueMap: Map<string, RawCodeScanIssue[]> = new Map()
    const aggregatedCodeScanIssueList: AggregatedCodeScanIssue[] = []
    const requester = (request: codewhispererClient.ListCodeScanFindingsRequest) => client.listCodeScanFindings(request)
    const collection = pageableToCollection(requester, { jobId, codeScanFindingsSchema }, 'nextToken')
    const issues = await collection
        .flatten()
        .map((resp) => {
            logger.verbose(`Request id: ${resp.$response.requestId}`)
            if ('codeScanFindings' in resp) {
                return resp.codeScanFindings
            }
            return resp.codeAnalysisFindings
        })
        .promise()
    issues.forEach((issue) => {
        mapToAggregatedList(codeScanIssueMap, issue, editor, scope)
    })
    codeScanIssueMap.forEach((issues, key) => {
        // Project path example: /Users/username/project
        // Key example: project/src/main/java/com/example/App.java
        projectPaths.forEach((projectPath) => {
            // We need to remove the project path from the key to get the absolute path to the file
            // Do not use .. in between because there could be multiple project paths in the same parent dir.
            const filePath = path.join(projectPath, key.split('/').slice(1).join('/'))
            if (existsSync(filePath) && statSync(filePath).isFile()) {
                const aggregatedCodeScanIssue: AggregatedCodeScanIssue = {
                    filePath: filePath,
                    issues: issues.map(mapRawToCodeScanIssue),
                }
                aggregatedCodeScanIssueList.push(aggregatedCodeScanIssue)
            }
        })
        const maybeAbsolutePath = `/${key}`
        if (existsSync(maybeAbsolutePath) && statSync(maybeAbsolutePath).isFile()) {
            const aggregatedCodeScanIssue: AggregatedCodeScanIssue = {
                filePath: maybeAbsolutePath,
                issues: issues.map(mapRawToCodeScanIssue),
            }
            aggregatedCodeScanIssueList.push(aggregatedCodeScanIssue)
        }
    })
    return aggregatedCodeScanIssueList
}

function mapRawToCodeScanIssue(issue: RawCodeScanIssue): CodeScanIssue {
    return {
        startLine: issue.startLine - 1 >= 0 ? issue.startLine - 1 : 0,
        endLine: issue.endLine,
        comment: `${issue.title.trim()}: ${issue.description.text.trim()}`,
        title: issue.title,
        description: issue.description,
        detectorId: issue.detectorId,
        detectorName: issue.detectorName,
        findingId: issue.findingId,
        ruleId: issue.ruleId,
        relatedVulnerabilities: issue.relatedVulnerabilities,
        severity: issue.severity,
        recommendation: issue.remediation.recommendation,
        suggestedFixes: issue.remediation.suggestedFixes,
    }
}

export function mapToAggregatedList(
    codeScanIssueMap: Map<string, RawCodeScanIssue[]>,
    json: string,
    editor: vscode.TextEditor | undefined,
    scope: CodeWhispererConstants.CodeAnalysisScope
) {
    const codeScanIssues: RawCodeScanIssue[] = JSON.parse(json)
    const filteredIssues = codeScanIssues.filter((issue) => {
        if (scope === CodeWhispererConstants.CodeAnalysisScope.FILE && editor) {
            for (let lineNumber = issue.startLine; lineNumber <= issue.endLine; lineNumber++) {
                const line = editor.document.lineAt(lineNumber - 1)?.text
                const codeContent = issue.codeSnippet.find((codeIssue) => codeIssue.number === lineNumber)?.content
                if (codeContent?.includes('***')) {
                    // CodeSnippet contains redacted code so we can't do a direct comparison
                    return line.length === codeContent.length
                } else {
                    return line === codeContent
                }
            }
        }
        return true
    })

    filteredIssues.forEach((issue) => {
        const filePath = issue.filePath
        if (codeScanIssueMap.has(filePath)) {
            codeScanIssueMap.get(filePath)?.push(issue)
        } else {
            codeScanIssueMap.set(filePath, [issue])
        }
    })
}

export async function pollScanJobStatus(
    client: DefaultCodeWhispererClient,
    jobId: string,
    scope: CodeWhispererConstants.CodeAnalysisScope,
    codeScanStartTime: number
) {
    const pollingStartTime = performance.now()
    // We don't expect to get results immediately, so sleep for some time initially to not make unnecessary calls
    await sleep(getPollingDelayMsForScope(scope))

    const logger = getLoggerForScope(scope)
    logger.verbose(`Polling scan job status...`)
    let status: string = 'Pending'
    while (true) {
        throwIfCancelled(scope, codeScanStartTime)
        const req: codewhispererClient.GetCodeScanRequest = {
            jobId: jobId,
        }
        const resp = await client.getCodeScan(req)
        logger.verbose(`Request id: ${resp.$response.requestId}`)
        if (resp.status !== 'Pending') {
            status = resp.status
            logger.verbose(`Scan job status: ${status}`)
            logger.verbose(`Complete Polling scan job status.`)
            break
        }
        throwIfCancelled(scope, codeScanStartTime)
        await sleep(CodeWhispererConstants.codeScanJobPollingIntervalSeconds * 1000)
        const elapsedTime = performance.now() - pollingStartTime
        if (elapsedTime > getPollingTimeoutMsForScope(scope)) {
            logger.verbose(`Scan job status: ${status}`)
            logger.verbose(`Security Scan failed. Amazon Q timed out.`)
            throw new SecurityScanTimedOutError()
        }
    }
    return status
}

export async function createScanJob(
    client: DefaultCodeWhispererClient,
    artifactMap: codewhispererClient.ArtifactMap,
    languageId: string,
    scope: CodeWhispererConstants.CodeAnalysisScope,
    scanName: string
) {
    const logger = getLoggerForScope(scope)
    logger.verbose(`Creating scan job...`)
    const req: codewhispererClient.CreateCodeScanRequest = {
        artifacts: artifactMap,
        programmingLanguage: {
            languageName: languageId,
        },
        scope: scope,
        codeScanName: scanName,
    }
    const resp = await client.createCodeScan(req).catch((err) => {
        getLogger().error(`Failed creating scan job. Request id: ${err.requestId}`)
        throw new CreateCodeScanError(err)
    })
    logger.verbose(`Request id: ${resp.$response.requestId}`)
    TelemetryHelper.instance.sendCodeScanEvent(languageId, resp.$response.requestId)
    return resp
}

export async function getPresignedUrlAndUpload(
    client: DefaultCodeWhispererClient,
    zipMetadata: ZipMetadata,
    scope: CodeWhispererConstants.CodeAnalysisScope,
    scanName: string
) {
    const logger = getLoggerForScope(scope)
    if (zipMetadata.zipFilePath === '') {
        getLogger().error('Failed to create valid source zip')
        throw new InvalidSourceZipError()
    }
    const srcReq: CreateUploadUrlRequest = {
        contentMd5: getMd5(zipMetadata.zipFilePath),
        artifactType: 'SourceCode',
        uploadIntent: getUploadIntent(scope),
        uploadContext: {
            codeAnalysisUploadContext: {
                codeScanName: scanName,
            },
        },
    }
    logger.verbose(`Prepare for uploading src context...`)
    const srcResp = await client.createUploadUrl(srcReq).catch((err) => {
        getLogger().error(`Failed getting presigned url for uploading src context. Request id: ${err.requestId}`)
        throw new CreateUploadUrlError(err)
    })
    logger.verbose(`Request id: ${srcResp.$response.requestId}`)
    logger.verbose(`Complete Getting presigned Url for uploading src context.`)
    logger.verbose(`Uploading src context...`)
    await uploadArtifactToS3(zipMetadata.zipFilePath, srcResp, scope)
    logger.verbose(`Complete uploading src context.`)
    const artifactMap: ArtifactMap = {
        SourceCode: srcResp.uploadId,
    }
    return artifactMap
}

function getUploadIntent(scope: CodeWhispererConstants.CodeAnalysisScope): UploadIntent {
    return scope === CodeWhispererConstants.CodeAnalysisScope.FILE
        ? CodeWhispererConstants.fileScanUploadIntent
        : CodeWhispererConstants.projectScanUploadIntent
}

function getMd5(fileName: string) {
    const hasher = crypto.createHash('md5')
    hasher.update(readFileSync(fileName))
    return hasher.digest('base64')
}

export function throwIfCancelled(scope: CodeWhispererConstants.CodeAnalysisScope, codeScanStartTime: number) {
    switch (scope) {
        case CodeWhispererConstants.CodeAnalysisScope.PROJECT:
            if (codeScanState.isCancelling()) {
                throw new CodeScanStoppedError()
            }
            break
        case CodeWhispererConstants.CodeAnalysisScope.FILE: {
            const latestCodeScanStartTime = CodeScansState.instance.getLatestScanTime()
            if (
                !CodeScansState.instance.isScansEnabled() ||
                (latestCodeScanStartTime && latestCodeScanStartTime > codeScanStartTime)
            ) {
                throw new CodeScanStoppedError()
            }
            break
        }
        default:
            getLogger().warn(`Unknown code analysis scope: ${scope}`)
            break
    }
}

export async function uploadArtifactToS3(
    fileName: string,
    resp: CreateUploadUrlResponse,
    scope: CodeWhispererConstants.CodeAnalysisScope
) {
    const logger = getLoggerForScope(scope)
    const encryptionContext = `{"uploadId":"${resp.uploadId}"}`
    const headersObj: Record<string, string> = {
        'Content-MD5': getMd5(fileName),
        'x-amz-server-side-encryption': 'aws:kms',
        'Content-Type': 'application/zip',
        'x-amz-server-side-encryption-context': Buffer.from(encryptionContext, 'utf8').toString('base64'),
    }

    if (resp.kmsKeyArn !== '' && resp.kmsKeyArn !== undefined) {
        headersObj['x-amz-server-side-encryption-aws-kms-key-id'] = resp.kmsKeyArn
    }

    try {
        const response = await request.fetch('PUT', resp.uploadUrl, {
            body: readFileSync(fileName),
            headers: resp?.requestHeaders ?? headersObj,
        }).response
        logger.debug(`StatusCode: ${response.status}, Text: ${response.statusText}`)
    } catch (error) {
        getLogger().error(
            `Amazon Q is unable to upload workspace artifacts to Amazon S3 for security scans. For more information, see the Amazon Q documentation or contact your network or organization administrator.`
        )
        const errorMessage = getTelemetryReasonDesc(error)?.includes(`"PUT" request failed with code "403"`)
            ? `"PUT" request failed with code "403"`
            : (getTelemetryReasonDesc(error) ?? 'Security scan failed.')

        throw new UploadArtifactToS3Error(errorMessage)
    }
}

export function getLoggerForScope(scope: CodeWhispererConstants.CodeAnalysisScope) {
    return scope === CodeWhispererConstants.CodeAnalysisScope.FILE ? getNullLogger() : getLogger()
}

function getPollingDelayMsForScope(scope: CodeWhispererConstants.CodeAnalysisScope) {
    return (
        (scope === CodeWhispererConstants.CodeAnalysisScope.FILE
            ? CodeWhispererConstants.fileScanPollingDelaySeconds
            : CodeWhispererConstants.projectScanPollingDelaySeconds) * 1000
    )
}

function getPollingTimeoutMsForScope(scope: CodeWhispererConstants.CodeAnalysisScope) {
    return (
        (scope === CodeWhispererConstants.CodeAnalysisScope.FILE
            ? CodeWhispererConstants.codeFileScanJobTimeoutSeconds
            : CodeWhispererConstants.codeScanJobTimeoutSeconds) * 1000
    )
}
