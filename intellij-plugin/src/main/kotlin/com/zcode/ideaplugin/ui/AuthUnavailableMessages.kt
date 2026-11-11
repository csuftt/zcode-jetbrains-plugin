package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.protocol.AccountProviderBridge
import com.zcode.ideaplugin.protocol.ProjectAccessTokenClient

/**
 * 凭证供给失败的用户文案渲染（errorMessage 追加句）。
 *
 * 协议层只产结构化原因（AccountProviderBridge.UnavailableCause / PAT FailKind），
 * 文案在 UI 层出（protocol-client 纯模块不可引 ZCodeBundle——2026-11-11 评审收口，
 * 由 ZCodeServiceImpl.registerProtocolHandlersLocked 注入 client.authUnavailableMessage）。
 * 口径沿用原 Failure.describe()：原因简述（detail 原样保留在括号里供诊断）。
 */
internal object AuthUnavailableMessages {

    fun render(cause: AccountProviderBridge.UnavailableCause): String = when (cause) {
        is AccountProviderBridge.UnavailableCause.UnknownProvider ->
            message("auth.unavailable.unknownProvider", cause.providerId)
        AccountProviderBridge.UnavailableCause.NoJwt ->
            message("auth.unavailable.noJwt")
        is AccountProviderBridge.UnavailableCause.NoIdentity ->
            message("auth.unavailable.noIdentity", cause.family)
        is AccountProviderBridge.UnavailableCause.UnsupportedMode ->
            message("auth.unavailable.unsupportedMode", cause.mode ?: "")
        is AccountProviderBridge.UnavailableCause.NoAccessToken ->
            message("auth.unavailable.noAccessToken", cause.family)
        is AccountProviderBridge.UnavailableCause.CredentialReadError ->
            message("auth.unavailable.credentialReadError", "${cause.type}: ${cause.message ?: "unknown"}")
        is AccountProviderBridge.UnavailableCause.PatFailed -> renderPat(cause.failure)
    }

    private fun renderPat(f: ProjectAccessTokenClient.Failure): String = when (f.kind) {
        ProjectAccessTokenClient.FailKind.NETWORK -> message("auth.pat.network", f.detail)
        ProjectAccessTokenClient.FailKind.UNAUTHORIZED -> message("auth.pat.unauthorized", f.detail)
        ProjectAccessTokenClient.FailKind.NOT_FOUND -> message("auth.pat.notFound", f.detail)
        ProjectAccessTokenClient.FailKind.SERVER -> message("auth.pat.server", f.detail)
        ProjectAccessTokenClient.FailKind.BAD_RESPONSE -> message("auth.pat.badResponse", f.detail)
        ProjectAccessTokenClient.FailKind.NO_PROJECT -> message("auth.pat.noProject", f.detail)
        ProjectAccessTokenClient.FailKind.EMPTY_TOKEN -> message("auth.pat.emptyToken", f.detail)
        ProjectAccessTokenClient.FailKind.SELECTION_MISSING -> message("auth.pat.selectionMissing", f.detail)
        ProjectAccessTokenClient.FailKind.NEGATIVE_CACHE -> message("auth.pat.negativeCache", f.detail)
        ProjectAccessTokenClient.FailKind.UNSUPPORTED -> f.detail
        ProjectAccessTokenClient.FailKind.UNEXPECTED -> message("auth.pat.unexpected", f.detail)
    }
}
