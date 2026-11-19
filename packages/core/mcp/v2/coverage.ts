/** Dashboard server actions and their corresponding v2 tool or owner surface. */
export const ACTION_COVERAGE = [
  {
    "action": "app/inbox/action-decisions.ts#approveLedgerAction",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#editAndApproveLedgerAction",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#skipLedgerAction",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#unscheduleLedgerAction",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#excludeLedgerPerson",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#resolveOutcomeAt",
    "kind": "tool",
    "target": "resolve_outcome",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#takeOverConversationAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#releaseConversationAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#resolveConversationReviewAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#handBackDmThreadAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#sendOwnerDmAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#sendOwnDmInsteadAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#recordOutcomeAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#excludePersonAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#stopCampaignActions",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#moveWakeAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#checkConversationNowAt",
    "kind": "app",
    "target": "",
    "note": "the owner's press: a read of their own LinkedIn account"
  },
  {
    "action": "app/inbox/action-decisions.ts#checkInvitationNowAt",
    "kind": "app",
    "target": "",
    "note": "the owner's press: a read of their own LinkedIn account"
  },
  {
    "action": "app/inbox/action-decisions.ts#cancelWakeAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/action-decisions.ts#resumePausedScope",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/inbox/room-actions.ts#skipRoomPerson",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/room-actions.ts#unskipRoomPerson",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/room-actions.ts#unskipRoom",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/settings/runtime/actions.ts#dismissMissedRuns",
    "kind": "screen",
    "target": "",
    "note": "screen navigation or a dismissed notice"
  },
  {
    "action": "app/inbox/conversations/memory-actions.ts#inspectMemoryAt",
    "kind": "tool",
    "target": "search_knowledge",
    "note": ""
  },
  {
    "action": "app/inbox/conversations/memory-actions.ts#previewForgetAt",
    "kind": "tool",
    "target": "delete_knowledge · dryRun",
    "note": ""
  },
  {
    "action": "app/inbox/conversations/memory-actions.ts#forgetMemoryAt",
    "kind": "tool",
    "target": "delete_knowledge",
    "note": ""
  },
  {
    "action": "app/inbox/conversations/memory-actions.ts#editMemoryAt",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/inbox/conversations/memory-actions.ts#allowRememberingAt",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#keepThemeInBrain",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#addKnowledgeFact",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#updateKnowledgeDoc",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#deleteKnowledgeDoc",
    "kind": "tool",
    "target": "delete_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#seedBrain",
    "kind": "tool",
    "target": "seed_brain",
    "note": ""
  },
  {
    "action": "app/brain/actions.ts#answerBrainQuestion",
    "kind": "tool",
    "target": "save_knowledge",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#addThemeToProduct",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#previewProductSource",
    "kind": "tool",
    "target": "scan_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#saveProduct",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#readSourceAgain",
    "kind": "tool",
    "target": "scan_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#updateProductDetails",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#setProductCampaigns",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#deleteProductFolder",
    "kind": "tool",
    "target": "delete_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#addProductFactDoc",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#updateProductFactDoc",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#deleteProductFactDoc",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#answerProductQuestionDoc",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#approveOfferDoc",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/brain/products/actions.ts#retireOfferDoc",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#setCampaignActive",
    "kind": "tool",
    "target": "save_campaign + Start in app",
    "note": "pause and create through the tool; Start stays the owner's"
  },
  {
    "action": "app/campaigns/new/actions.ts#createAndStartCampaign",
    "kind": "tool",
    "target": "save_campaign · startingPoint + Start in app",
    "note": "create through the tool from a starting point; Start stays the owner's"
  },
  {
    "action": "app/campaigns/new/actions.ts#fillTheRest",
    "kind": "app",
    "target": "",
    "note": "a server model helper that writes nothing; chat has propose_campaign_fill, and the calling agent writes the values itself"
  },
  {
    "action": "app/campaigns/worker-blocks/one-each-actions.ts#saveCampaignProduct",
    "kind": "tool",
    "target": "save_campaign · productId",
    "note": ""
  },
  {
    "action": "app/campaigns/worker-blocks/one-each-actions.ts#saveCampaignVoice",
    "kind": "tool",
    "target": "save_campaign · voiceId",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#duplicateCampaign",
    "kind": "tool",
    "target": "save_campaign · duplicateFrom",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#deleteCampaign",
    "kind": "tool",
    "target": "delete_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#decideCampaignDelete",
    "kind": "app",
    "target": "",
    "note": "the owner's confirmation"
  },
  {
    "action": "app/campaigns/actions.ts#decideCampaignFacts",
    "kind": "app",
    "target": "",
    "note": "the owner's confirmation"
  },
  {
    "action": "app/campaigns/actions.ts#runCampaignNow",
    "kind": "tool",
    "target": "run_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#runCampaignTest",
    "kind": "tool",
    "target": "run_campaign · run: test",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#stopCampaignSending",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#resumeCampaignSending",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#saveCampaignFacts",
    "kind": "tool",
    "target": "save_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#makeSearchStandard",
    "kind": "tool",
    "target": "save_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#keepQuickSearch",
    "kind": "tool",
    "target": "save_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#proposeStrategyPatch",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#saveStepEdits",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#proposeAutomaticOffer",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#keepAutomaticOfferAsIs",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#addCampaignStep",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#startFromTemplate",
    "kind": "tool",
    "target": "save_campaign · template",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#startCampaign",
    "kind": "app",
    "target": "",
    "note": "the owner's confirmation"
  },
  {
    "action": "app/campaigns/actions.ts#redrawExpiredDesign",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#adoptExpiredDesign",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#undoStrategyVersion",
    "kind": "tool",
    "target": "patch_strategy",
    "note": ""
  },
  {
    "action": "app/campaigns/actions.ts#decideStrategyChange",
    "kind": "app",
    "target": "",
    "note": "owner confirmation"
  },
  {
    "action": "app/campaigns/audience-settings-actions.ts#suggestAudience",
    "kind": "app",
    "target": "",
    "note": "a server model helper; the calling agent writes the suggestion itself and saves it"
  },
  {
    "action": "app/campaigns/audience-settings-actions.ts#olderAudienceHistory",
    "kind": "tool",
    "target": "get_campaign",
    "note": ""
  },
  {
    "action": "app/campaigns/search-actions.ts#readItsRoom",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/search-actions.ts#loadLookalike",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/search-actions.ts#addFromLookalike",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/search-actions.ts#skipFromLookalike",
    "kind": "app",
    "target": "",
    "note": "dismisses a search suggestion in the screen"
  },
  {
    "action": "app/campaigns/searches-actions.ts#addSearch",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#addSearchPlace",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#replaceSearch",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#pinSearch",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#retireSearch",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#restoreSearch",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#followSearchSource",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#dismissSearchSource",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/campaigns/searches-actions.ts#undoSearchChange",
    "kind": "tool",
    "target": "edit_searches",
    "note": ""
  },
  {
    "action": "app/channels/account-policy-actions.ts#changeAccountPolicy",
    "kind": "tool",
    "target": "update_channel",
    "note": ""
  },
  {
    "action": "app/channels/account-policy-actions.ts#decideAccountPolicyChange",
    "kind": "app",
    "target": "",
    "note": "the owner's confirmation"
  },
  {
    "action": "app/channels/actions.ts#approveMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#editAndApproveMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#setLikeWithSend",
    "kind": "tool",
    "target": "decide · likeWithSend",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#rejectMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#skipMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#chooseDraftVariant",
    "kind": "tool",
    "target": "decide · variant",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#chooseComposerAngle",
    "kind": "screen",
    "target": "",
    "note": "fills the composer box from an angle already delivered"
  },
  {
    "action": "app/channels/actions.ts#unscheduleMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#dropScheduledLike",
    "kind": "tool",
    "target": "decide · likeWithSend",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#restoreMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#retryFailedMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#editFailedMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#postNowScheduledMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#postNowMessage",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#saveCeilings",
    "kind": "tool",
    "target": "update_channel",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#setWriteAuthority",
    "kind": "app",
    "target": "",
    "note": "turning on live writes is never inferred"
  },
  {
    "action": "app/channels/actions.ts#enableKillSwitch",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#disableKillSwitch",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#clearAutoPause",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/channels/actions.ts#saveOwnPostReplies",
    "kind": "tool",
    "target": "update_channel",
    "note": ""
  },
  {
    "action": "app/channels/linkedin/live-checks/actions.ts#runLiveCheckRead",
    "kind": "app",
    "target": "",
    "note": "live checks on the real account"
  },
  {
    "action": "app/channels/linkedin/live-checks/actions.ts#answerLiveCheckRead",
    "kind": "app",
    "target": "",
    "note": "live checks on the real account"
  },
  {
    "action": "app/channels/linkedin/live-checks/actions.ts#sendLiveCheckWrite",
    "kind": "app",
    "target": "",
    "note": "live checks on the real account"
  },
  {
    "action": "app/channels/linkedin/live-checks/actions.ts#clearRecordedLiveCheck",
    "kind": "app",
    "target": "",
    "note": "live checks on the real account"
  },
  {
    "action": "app/channels/linkedin/pause-actions.ts#pauseLinkedIn",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/channels/linkedin/pause-actions.ts#resumeLinkedIn",
    "kind": "tool",
    "target": "stop",
    "note": ""
  },
  {
    "action": "app/channels/linkedin/requests/request-actions.ts#acceptIncomingRequest",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/channels/linkedin/requests/request-actions.ts#linkIncomingRequest",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/channels/linkedin/requests/request-actions.ts#dismissIncomingRequest",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/chat/actions.ts#decideProposedChange",
    "kind": "app",
    "target": "",
    "note": "the owner's confirmation"
  },
  {
    "action": "app/inbox/composer-actions.ts#redraftAngleAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/composer-actions.ts#draftAngleAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/composer-actions.ts#moreAnglesAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/composer-actions.ts#suggestAngleAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/composer-actions.ts#cancelAngleAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/composer-actions.ts#checkWordsAt",
    "kind": "app",
    "target": "",
    "note": "the box's line under its draft; a press through act or decide meets the same check"
  },
  {
    "action": "app/inbox/first-look-actions.ts#retryStoppedFirstLook",
    "kind": "tool",
    "target": "run_campaign",
    "note": ""
  },
  {
    "action": "app/inbox/first-look-actions.ts#suggestWiderLine",
    "kind": "app",
    "target": "",
    "note": "a server model helper; the calling agent writes the suggestion itself and saves it"
  },
  {
    "action": "app/inbox/first-look-actions.ts#runFirstLookAgain",
    "kind": "tool",
    "target": "run_campaign",
    "note": ""
  },
  {
    "action": "app/inbox/first-look-actions.ts#keepFirstLookAsIs",
    "kind": "screen",
    "target": "",
    "note": "screen navigation or a dismissed notice"
  },
  {
    "action": "app/inbox/invite-actions.ts#withdrawInviteAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#inviteFromHeader",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#loadRoomInviteAt",
    "kind": "tool",
    "target": "get_drafting_context",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#readFromInbox",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#unreadFromInbox",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#archiveFromInbox",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#unarchiveFromInbox",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/inbox/person-actions.ts#acceptFromHeader",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/reply-actions.ts#saveReplyAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/reply-actions.ts#likeAndDismissReplyAt",
    "kind": "tool",
    "target": "act + decide",
    "note": ""
  },
  {
    "action": "app/inbox/reply-actions.ts#dontReplyAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/reply-actions.ts#undoDontReplyAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/reply-actions.ts#cancelReplyDraftAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/room-draft-actions.ts#requestRoomDraftAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#loadRoomReplyReceiptAt",
    "kind": "tool",
    "target": "list_activity",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#cancelRoomReplyReceiptAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#loadRoomReplyAt",
    "kind": "tool",
    "target": "get_drafting_context",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#saveRoomReplyAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#queueRoomReplyAt",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-actions.ts#cancelRoomReplyAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-review-actions.ts#approveRoomReplyReviewAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-review-actions.ts#saveRoomReplyReviewAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-review-actions.ts#skipRoomReplyReviewAt",
    "kind": "tool",
    "target": "decide",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-review-actions.ts#redraftRoomReplyReviewAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/room-reply-review-actions.ts#cancelRoomReplyReviewRedraftAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/inbox/thread-actions.ts#likeOnThread",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/thread-actions.ts#commentOnThread",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/inbox/thread-actions.ts#replyOnThread",
    "kind": "tool",
    "target": "act",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#queueOpenerAt",
    "kind": "tool",
    "target": "request_draft",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#researchSignalAt",
    "kind": "tool",
    "target": "research_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#researchNewestSignals",
    "kind": "tool",
    "target": "research_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#setAsideAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#bringBackAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#rateLeadAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#readLeadAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/leads/actions.ts#markNewAt",
    "kind": "tool",
    "target": "update_person",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#rejectLinkedInAccount",
    "kind": "app",
    "target": "",
    "note": "connecting the LinkedIn account happens in the browser"
  },
  {
    "action": "app/onboarding/actions.ts#startBrainImport",
    "kind": "tool",
    "target": "seed_brain",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#previewProduct",
    "kind": "tool",
    "target": "scan_product",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#savedSetupProduct",
    "kind": "tool",
    "target": "list_products",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#saveSetupProduct",
    "kind": "tool",
    "target": "save_product",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#skipSetupProduct",
    "kind": "tool",
    "target": "complete_setup · skip",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#saveCampaignDraft",
    "kind": "tool",
    "target": "save_campaign",
    "note": ""
  },
  {
    "action": "app/onboarding/actions.ts#draftFirstCampaign",
    "kind": "app",
    "target": "",
    "note": "a server model helper; the calling agent writes the suggestion itself and saves it"
  },
  {
    "action": "app/onboarding/actions.ts#backToProduct",
    "kind": "screen",
    "target": "",
    "note": "screen navigation or a dismissed notice"
  },
  {
    "action": "app/onboarding/actions.ts#createFirstCampaign",
    "kind": "tool",
    "target": "save_campaign",
    "note": ""
  },
  {
    "action": "app/onboarding/review-context.ts#readFirstCampaignReview",
    "kind": "tool",
    "target": "get_campaign",
    "note": ""
  },
  {
    "action": "app/settings/actions.ts#renameOrg",
    "kind": "tool",
    "target": "update_settings · orgName",
    "note": ""
  },
  {
    "action": "app/settings/actions.ts#saveAccountNameAction",
    "kind": "app",
    "target": "",
    "note": "the owner's name on their Engager account, authenticated by this Mac's sign-in"
  },
  {
    "action": "app/settings/agent/actions.ts#saveModelSettings",
    "kind": "tool",
    "target": "update_settings",
    "note": ""
  },
  {
    "action": "app/settings/agent/picker-actions.ts#readAgentPicker",
    "kind": "app",
    "target": "",
    "note": "choosing the agent CLI that serves Engager"
  },
  {
    "action": "app/settings/agent/picker-actions.ts#saveAgentSelection",
    "kind": "app",
    "target": "",
    "note": "choosing the agent CLI that serves Engager"
  },
  {
    "action": "app/settings/agent/picker-actions.ts#repairAgent",
    "kind": "app",
    "target": "",
    "note": "choosing the agent CLI that serves Engager"
  },
  {
    "action": "app/settings/agent/picker-actions.ts#resolveAgentPath",
    "kind": "app",
    "target": "",
    "note": "choosing the agent CLI that serves Engager"
  },
  {
    "action": "app/settings/browser/actions.ts#chooseBrowserWindow",
    "kind": "app",
    "target": "",
    "note": "the local browser window"
  },
  {
    "action": "app/settings/browser/actions.ts#revealBrowser",
    "kind": "app",
    "target": "",
    "note": "the local browser window"
  },
  {
    "action": "app/settings/browser/actions.ts#restartBrowser",
    "kind": "app",
    "target": "",
    "note": "the local browser window"
  },
  {
    "action": "app/settings/browser/actions.ts#openPrivacySettings",
    "kind": "app",
    "target": "",
    "note": "the local browser window"
  },
  {
    "action": "app/settings/mac/actions.ts#setKeepAwake",
    "kind": "app",
    "target": "",
    "note": "keeping this Mac awake"
  },
  {
    "action": "app/settings/mac/actions.ts#setKeepAwakePluggedInOnly",
    "kind": "app",
    "target": "",
    "note": "keeping this Mac awake"
  },
  {
    "action": "app/settings/mac/actions.ts#keepThisMacAwake",
    "kind": "app",
    "target": "",
    "note": "keeping this Mac awake"
  },
  {
    "action": "app/settings/reports/actions.ts#retryReport",
    "kind": "app",
    "target": "",
    "note": "bug reports"
  },
  {
    "action": "app/settings/reports/actions.ts#deleteReport",
    "kind": "app",
    "target": "",
    "note": "bug reports"
  },
  {
    "action": "app/usage-notice-actions.ts#dismissUsageDataNotice",
    "kind": "screen",
    "target": "",
    "note": "screen navigation or a dismissed notice"
  },
  {
    "action": "app/voice/actions.ts#saveVoice",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#relearnNow",
    "kind": "tool",
    "target": "learn_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#saveVoiceTraits",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#removeVoiceRuleAt",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#setStartingRuleLineAt",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#keepVoiceExample",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#addExample",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#removeExample",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#pinExample",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#keepProposedDescription",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#dropProposedDescription",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/actions.ts#setLearnedEdit",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/new/actions.ts#createVoiceFromForm",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/sample-actions.ts#answerSample",
    "kind": "app",
    "target": "",
    "note": "the owner's answer: whether a sample sounds like them is theirs to say"
  },
  {
    "action": "app/voice/question-actions.ts#answerVoiceQuestionAction",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  },
  {
    "action": "app/voice/question-actions.ts#saveOwnWords",
    "kind": "tool",
    "target": "save_voice",
    "note": ""
  }
] as const;
