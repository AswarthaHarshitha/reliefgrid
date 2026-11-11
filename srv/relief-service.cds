using reliefgrid as db from '../db/schema';

/**
 * Service for camp coordinators and the district relief control room.
 * Camp master data is edited through drafts; stock, requests and pledges
 * change only through the actions below so every change is deliberate.
 */
@path    : '/odata/v4/relief'
@requires: 'Coordinator'
service ReliefService {

  @odata.draft.enabled
  entity Camps         as
    projection on db.Camps {
      *,
      health : redirected to CampHealth,
      householdInfo : redirected to CampHouseholds,
      phaseInfo : redirected to CampPhases,
      /** Whether Delete would be accepted: only for a camp without counts, requests or decisions (ARCH-04, UX-07). */
      virtual deletable : Boolean
    }
    actions {
      @(Common.SideEffects.TargetEntities: ['in/stock', 'in/requests', 'in/health'])
      /** Without targetDays, the replenishment target from the planning settings applies. */
      action raiseRequests(targetDays : Integer @title: '{i18n>TargetDays}') returns RaiseResult;

      /** UX-05: what Raise Requests would publish now, line by line; reads only. */
      function previewRequests(targetDays : Integer) returns many RequestPreview;

      @(Common.SideEffects.TargetEntities: ['in/requests'])
      action requestSupplies(
        @(title: '{i18n>Standard}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'Standards',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: standard, ValueListProperty: 'code'}]
        }})
        standard : String(12),
        @(title: '{i18n>Quantity}', mandatory)
        quantity : db.Quantity,
        @(title: '{i18n>NeededBy}')
        neededBy : Date,
        @(title: '{i18n>Note}', UI.MultiLineText)
        note     : String(500)
      )                                                                   returns Requests;

      @(Common.SideEffects.TargetEntities: ['in', 'in/requests'])
      action closeCamp()                                                  returns Camps;

      /** Proposes whether an indicator applies to this camp; an Administrator other than the proposer approves. */
      @(Common.SideEffects.TargetEntities: ['in/decisions'])
      action proposeApplicability(
        @(title: '{i18n>Standard}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'Standards',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: standard, ValueListProperty: 'code'}]
        }})
        standard      : String(12),
        @(title: '{i18n>Applicability}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ApplicabilityOptions',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: applicability, ValueListProperty: 'code'}]
        }})
        applicability : String(20),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date,
        /** Unticked (default): submitted for approval at once. Ticked: kept as a draft. */
        @(title: '{i18n>SaveAsDraft}')
        saveAsDraft   : Boolean
      )                                                                   returns CampDecisions;

      /** Proposes to end the applicability decision in force (back to "not decided"); needs the same approval. */
      @(Common.SideEffects.TargetEntities: ['in/decisions'])
      action proposeWithdrawal(
        @(title: '{i18n>Standard}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'Standards',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: standard, ValueListProperty: 'code'}]
        }})
        standard      : String(12),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date
      )                                                                   returns CampDecisions;

      /**
       * Proposes a local target for one indicator of this camp (B4.2): a requirement per person that replaces
       * the reference figure for this camp only. Needs a reason, a source, a review date and an approver who
       * is not the proposer. The reference figure itself never changes.
       */
      @(Common.SideEffects.TargetEntities: ['in/decisions'])
      action proposeTarget(
        @(title: '{i18n>Standard}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'Standards',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: standard, ValueListProperty: 'code'}]
        }})
        standard      : String(12),
        @(title: '{i18n>TargetPerPerson}', mandatory)
        targetPerPerson : Decimal(12, 6),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}', mandatory)
        source        : String(300),
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date,
        @(title: '{i18n>SaveAsDraft}')
        saveAsDraft   : Boolean
      )                                                                   returns CampDecisions;

      /** Proposes to end the local target in force (back to the reference figure); needs the same approval. */
      @(Common.SideEffects.TargetEntities: ['in/decisions'])
      action proposeTargetWithdrawal(
        @(title: '{i18n>Standard}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'Standards',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: standard, ValueListProperty: 'code'}]
        }})
        standard      : String(12),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date
      )                                                                   returns CampDecisions;
      /**
       * Proposes the camp's response phase (B4.4): first phase of a rapid-onset crisis (toilets 1 per 50) or medium
       * term (1 per 20). Needs a reason, an effective date, a review date and an Administrator who is not the proposer.
       */
      @(Common.SideEffects.TargetEntities: ['in/decisions', 'in/phaseInfo'])
      action proposePhase(
        @(title: '{i18n>ResponsePhase}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ResponsePhases',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: responsePhase, ValueListProperty: 'code'}]
        }})
        responsePhase : String(12),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>EffectiveFrom}', mandatory)
        effectiveFrom : Date,
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>SaveAsDraft}')
        saveAsDraft   : Boolean
      )                                                                   returns CampDecisions;

      /** Proposes to end the response-phase decision in force (back to the medium term by default); needs the same approval. */
      @(Common.SideEffects.TargetEntities: ['in/decisions', 'in/phaseInfo'])
      action proposePhaseWithdrawal(
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>EffectiveFrom}', mandatory)
        effectiveFrom : Date
      )                                                                   returns CampDecisions;
    };

  /**
   * Local decisions for camps: applicability (B4.1), local targets (B4.2) and response phase (B4.4). Read-only as an entity;
   * every change goes through an action, and approval and rejection require an
   * Administrator who is not the proposer. The virtual fields tell the UI what
   * the signed-in user may do; the actions check it again.
   */
  @readonly
  entity CampDecisions           as
    projection on db.CampDecisions {
      *,
      virtual null as canApprove      : Boolean,
      virtual null as canReject       : Boolean,
      virtual null as canSubmit       : Boolean,
      virtual null as canRevise       : Boolean,
      virtual null as canWithdraw     : Boolean,
      virtual null as reviewOverdue   : Boolean,
      virtual null as displayStatus   : String(60),
      virtual null as approvalNote    : String(200),
      virtual null as valueText       : String(120),
      virtual null as previousText    : String(120),
      virtual null as canReviseTarget : Boolean,
      virtual null as canReview       : Boolean,
      /** NOT_DUE, DUE_TODAY, OVERDUE, COMPLETED, SUPERSEDED or WITHDRAWN (B4.2). */
      virtual null as reviewState     : String(20),
      virtual null as reviewStateText : String(120),
      /** When the next review is due: the review date, or the next date set by the last confirming review. */
      virtual null as reviewDue       : Date,
      virtual null as kindText        : String(40),
      virtual null as referenceText   : String(120),
      virtual null as canRevisePhase  : Boolean,
      /** The indicator name, or "Response phase" for a camp-wide phase decision. */
      virtual null as subjectText     : String(111)
    }
    actions {
      @(Common.SideEffects.TargetEntities: ['in', 'in/camp/stock', 'in/camp/health', 'in/camp/requests'])
      action submit(@(title: '{i18n>Version}') version : Integer)        returns CampDecisions;

      @(Common.SideEffects.TargetEntities: ['in'])
      action reviseDraft(
        @(title: '{i18n>Applicability}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ApplicabilityOptions',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: applicability, ValueListProperty: 'code'}]
        }})
        applicability : String(20),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date,
        @(title: '{i18n>Version}')
        version       : Integer
      )                                                                   returns CampDecisions;

      /** Edits the proposer's own local target draft (B4.2). */
      @(Common.SideEffects.TargetEntities: ['in'])
      action reviseTargetDraft(
        @(title: '{i18n>TargetPerPerson}', mandatory)
        targetPerPerson : Decimal(12, 6),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}', mandatory)
        source        : String(300),
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>EffectiveFrom}')
        effectiveFrom : Date,
        @(title: '{i18n>Version}')
        version       : Integer
      )                                                                   returns CampDecisions;

      /** Edits the proposer's own response-phase draft (B4.4). */
      @(Common.SideEffects.TargetEntities: ['in'])
      action revisePhaseDraft(
        @(title: '{i18n>ResponsePhase}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ResponsePhases',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: responsePhase, ValueListProperty: 'code'}]
        }})
        responsePhase : String(12),
        @(title: '{i18n>DecisionReason}', mandatory, UI.MultiLineText)
        reason        : String(500),
        @(title: '{i18n>DecisionSource}')
        source        : String(300),
        @(title: '{i18n>EffectiveFrom}', mandatory)
        effectiveFrom : Date,
        @(title: '{i18n>ReviewDate}', mandatory)
        reviewDate    : Date,
        @(title: '{i18n>Version}')
        version       : Integer
      )                                                                   returns CampDecisions;

      @(Common.SideEffects.TargetEntities: ['in'])
      action withdrawProposal(@(title: '{i18n>Version}') version : Integer) returns CampDecisions;

      /**
       * Records the periodic review of a decision in force (B4.2). Confirmed: stays in force until the next review
       * date. Change proposed: a replacement or withdrawal is waiting for approval. Never changes the decision.
       */
      @(requires: 'Administrator', Common.SideEffects.TargetEntities: ['in', 'in/reviews'])
      action completeReview(
        @(title: '{i18n>ReviewOutcome}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ReviewOutcomes',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: outcome, ValueListProperty: 'code'}]
        }})
        outcome           : String(20),
        @(title: '{i18n>ReviewExplanation}', mandatory, UI.MultiLineText)
        explanation       : String(500),
        @(title: '{i18n>NextReviewDate}')
        nextReviewDate    : Date,
        /** Optional for API clients: the open proposal is found when there is exactly one. */
        @(title: '{i18n>ResultingDecision}', UI.Hidden)
        resultingDecision : UUID,
        @(title: '{i18n>Version}')
        version           : Integer
      )                                                                   returns CampDecisions;

      @(requires: 'Administrator', Common.SideEffects.TargetEntities: ['in', 'in/camp/stock', 'in/camp/health', 'in/camp/requests'])
      action approve(@(title: '{i18n>Version}') version : Integer)       returns CampDecisions;

      @(requires: 'Administrator', Common.SideEffects.TargetEntities: ['in'])
      action rejectProposal(
        @(title: '{i18n>RejectionReason}', mandatory, UI.MultiLineText)
        reason  : String(500),
        @(title: '{i18n>Version}')
        version : Integer
      )                                                                   returns CampDecisions;
    };

  // The version doubles as ETag: UI5 sends it as If-Match with every bound action, and CAP refuses a stale one (412).
  annotate CampDecisions with {
    version @odata.etag;
  };

  /** Periodic reviews of decisions in force (B4.2); written only through CampDecisions.completeReview. */
  @readonly
  entity DecisionReviews         as projection on db.DecisionReviews;

  /** Reviews of requests flagged by applicability or local target changes; resolved through Requests.resolveReview. */
  @readonly
  entity RequestReviews          as projection on db.RequestReviews;

  @readonly
  entity Stock         as projection on db.Stock
    actions {
      @(Common.SideEffects.TargetEntities: ['in', 'in/camp/health'])
      action recordCount(
        quantity        : db.Quantity @title: '{i18n>CountedQuantity}' @mandatory,
        /** Toilets and taps only (B4.5): units confirmed as functional. Leave empty when functionality was not checked. */
        functionalUnits : db.Quantity @title: '{i18n>FunctionalUnits}'
      ) returns Stock;
    };

  @readonly
  entity Requests      as projection on db.Requests
    actions {
      @(Common.SideEffects.TargetEntities: ['in'])
      action cancel() returns Requests;

      /** Keeps or cancels a request flagged for review; pledges, deliveries and stock are never changed. */
      @(Common.SideEffects.TargetEntities: ['in', 'in/reviews', 'in/currentReview'])
      action resolveReview(
        @(title: '{i18n>ReviewResolution}', mandatory, Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ReviewResolutions',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: resolution, ValueListProperty: 'code'}]
        }})
        resolution : String(10),
        @(title: '{i18n>ReviewReason}', mandatory, UI.MultiLineText)
        reason     : String(500)
      ) returns Requests;
    };

  @readonly
  entity Pledges       as projection on db.Pledges
    actions {
      /**
       * Records one arrival of goods (ARCH-02, ARCH-03): received and accepted (usable) quantity,
       * condition and, for damaged or rejected goods or more than was pledged, a reason.
       */
      @(Common.SideEffects.TargetEntities: ['in', 'in/request', 'in/receipts'])
      action confirmDelivery(
        @(title: '{i18n>ReceivedQuantity}', mandatory) receivedQuantity : db.Quantity,
        @(title: '{i18n>AcceptedQuantity}', Common.QuickInfo: '{i18n>AcceptedQuantityInfo}') acceptedQuantity : db.Quantity,
        @(title: '{i18n>ReceiptCondition}', Common: {ValueListWithFixedValues, ValueList: {
          CollectionPath: 'ReceiptConditions',
          Parameters    : [{$Type: 'Common.ValueListParameterInOut', LocalDataProperty: condition, ValueListProperty: 'code'}]
        }}) condition : String(10),
        @(title: '{i18n>ReceiptReason}', UI.MultiLineText) reason : String(500),
        @(title: '{i18n>ClosePledgeWithReceipt}') closePledge : Boolean
      ) returns Pledges;

      /** Closes a partly received pledge when no more goods are expected; the rest goes back on the board. */
      @(Common.SideEffects.TargetEntities: ['in', 'in/request'])
      action closePledge(@(title: '{i18n>ClosePledgeReason}', mandatory) reason : String(500)) returns Pledges;

      @(Common.SideEffects.TargetEntities: ['in', 'in/request'])
      action withdraw()                                                                                 returns Pledges;

      /** SEC-05: withdraws every pledge in transit made by the same donor account, with a reason. */
      @(Common.SideEffects.TargetEntities: ['in', 'in/request'])
      action withdrawAllOfDonor(@(title: '{i18n>WithdrawAllReason}', mandatory) reason : String(500)) returns Integer;
    };

  /** Arrivals of goods, per pledge (ARCH-03). Append-only. */
  @readonly
  entity DeliveryReceipts        as projection on db.DeliveryReceipts;

  /** The stock ledger (ARCH-05). Append-only. */
  @readonly
  entity StockMovements          as projection on db.StockMovements;

  /** The supply audit trail (ARCH-05). Append-only. */
  @readonly
  entity AuditEvents             as projection on db.AuditEvents;

  /** GOOD, DAMAGED or REJECTED, for the receipt dialog. */
  @readonly
  entity ReceiptConditions       as projection on db.ReceiptConditions;

  @readonly
  @cds.redirection.target: false
  entity CampHealth    as projection on db.CampHealth;

  /** Households counted or estimated, per camp (B4.3). */
  @readonly
  @cds.redirection.target: false
  entity CampHouseholds as projection on db.CampHouseholds;

  /**
   * The household planning assumption (B4.3), separate from the planning settings.
   * Coordinators read it. A change needs two Administrators: one proposes it,
   * with a reason; another approves it (B4.3 governance).
   */
  @readonly
  entity HouseholdAssumption     as projection on db.HouseholdAssumption
    actions {
      @(requires: 'Administrator')
      action proposeSize(
        @(title: '{i18n>HouseholdSize}', mandatory) householdSize : Decimal(4, 1),
        @(title: '{i18n>ChangeReason}', mandatory) reason         : String(500),
        @(title: '{i18n>SettingsVersion}', mandatory) version     : Integer
      ) returns HouseholdSizeProposals;
    };

  /** Who proposed and who approved each household-size change, when, why, and from what to what. */
  @readonly
  entity HouseholdAssumptionChanges as projection on db.HouseholdAssumptionChanges;

  /** Household-size proposals, waiting or decided (B4.3 governance). */
  @readonly
  entity HouseholdSizeProposals  as projection on db.HouseholdSizeProposals
    actions {
      /** By an Administrator other than the proposer. */
      @(requires: 'Administrator')
      action approve() returns HouseholdChangeResult;
      /** By an Administrator other than the proposer, with a reason. */
      @(requires: 'Administrator')
      action rejectProposal(
        @(title: '{i18n>RejectReason}', mandatory) reason : String(500)
      ) returns HouseholdSizeProposals;
      /** By the proposer. */
      @(requires: 'Administrator')
      action withdraw() returns HouseholdSizeProposals;
    };

  @readonly
  entity Standards     as projection on db.Standards;

  @readonly
  entity Sectors       as projection on db.Sectors;

  @readonly
  entity Hazards       as projection on db.Hazards;

  @readonly
  entity CampStatus    as projection on db.CampStatus;

  @readonly
  entity RequestStatus as projection on db.RequestStatus;

  @readonly
  entity PledgeStatus  as projection on db.PledgeStatus;

  @readonly
  entity Priorities    as projection on db.Priorities;

  @readonly
  entity DecisionStatus       as projection on db.DecisionStatus;

  @readonly
  entity RequestReviewStates  as projection on db.RequestReviewStates;

  @readonly
  entity ApplicabilityOptions as projection on db.ApplicabilityOptions;

  @readonly
  entity ReviewResolutions    as projection on db.ReviewResolutions;

  @readonly
  entity ReviewOutcomes       as projection on db.ReviewOutcomes;

  @readonly
  entity ResponsePhases       as projection on db.ResponsePhases;

  /** The response phase in force per camp (B4.4). */
  @readonly
  @cds.redirection.target: false
  entity CampPhases           as projection on db.CampPhases;

  /**
   * ReliefGrid's operational planning choices (not Sphere requirements).
   * Coordinators read them; only Administrators change them, with a reason.
   */
  @readonly
  entity PlanningSettings        as projection on db.PlanningSettings
    actions {
      @(requires: 'Administrator')
      action change(
        @(title: '{i18n>CriticalDays}', mandatory) criticalDays       : Decimal(6, 2),
        @(title: '{i18n>WarningDays}', mandatory) warningDays         : Decimal(6, 2),
        @(title: '{i18n>CriticalPercent}', mandatory) criticalPercent : Decimal(5, 2),
        @(title: '{i18n>WarningPercent}', mandatory) warningPercent   : Decimal(5, 2),
        @(title: '{i18n>TargetDays}', mandatory) targetDays           : Integer,
        @(title: '{i18n>ChangeReason}', mandatory) reason             : String(500),
        /** The version the change was based on; a stale version is refused, so no change is lost. */
        @(title: '{i18n>SettingsVersion}', mandatory) version         : Integer
      ) returns SettingsChangeResult;
    };

  /**
   * What ReliefGrid calculated for a camp, when, why and from which inputs.
   * Append-only: written only by the service itself, never through OData.
   */
  @readonly
  entity AssessmentRecords       as projection on db.AssessmentRecords;

  @readonly
  entity AssessmentRecordLines   as projection on db.AssessmentRecordLines;

  /** Who changed the planning settings, when, why, and from what to what. */
  @readonly
  entity PlanningSettingsChanges as projection on db.PlanningSettingsChanges;

  type HouseholdChangeResult {
    /** Indicator lines in active camps whose state changed with the approval. */
    linesChanged    : Integer;
    /** Active camps with at least one such line. */
    campsChanged    : Integer;
    /** Version of the household assumption after the change. */
    version         : Integer;
    /** Outstanding requests flagged for review because their requirement changed. */
    requestsFlagged : Integer;
  }

  type SettingsChangeResult {
    /** Indicator lines in active camps whose state changed with this save. */
    linesChanged : Integer;
    /** Active camps with at least one such line. */
    campsChanged : Integer;
    /** Version of the settings record after this change. */
    version      : Integer;
  }

  type PlanningAccess {
    canChange : Boolean;
    /** The signed-in user, so a page can tell a proposer from another Administrator (display only). */
    user      : String(255);
  }

  /** Whether the signed-in user may change the planning settings. */
  function planningAccess() returns PlanningAccess;

  /** The operation time zone and today's date in it (ARCH-08). */
  type Operation {
    timeZone : String(60);
    today    : Date;
  }
  function operation() returns Operation;

  /** One line Raise Requests would publish, with how its quantity was worked out (UX-05). */
  type RequestPreview {
    standardCode : String(12);
    standardName : String(111);
    unit         : String(30);
    /** Consumption (daily need) or Coverage (total need). */
    basis        : String(12);
    /** Daily need for consumables, total need for infrastructure. */
    requirement  : Decimal(18, 1);
    /** What the request tops up to: the need for the target days, or the total need. */
    target       : Decimal(18, 1);
    targetDays   : Integer;
    onHand       : Decimal(18, 1);
    /** Still to arrive on outstanding requests. */
    incoming     : Decimal(18, 1);
    quantity     : Integer;
    priority     : Integer;
    neededBy     : Date;
  }

  /** Outcome of one Raise Requests operation, counted while it ran. */
  type RaiseResult {
    /** Requests created by this operation. */
    created     : Integer;
    /** Lines skipped by this operation because their stock was never counted. */
    skipped     : Integer;
    /** True when the camp has no people recorded, so nothing could be assessed. */
    notAssessed : Boolean;
    /** Lines skipped because the indicator is not decided, not applicable or has no requirement. */
    needsDecision : Integer;
    /** Toilet and tap lines skipped because their functionality is not confirmed (B4.5). */
    notVerified   : Integer;
  }

  /** One item that needs a coordinator's or an administrator's attention. */
  type AttentionItem {
    /** NOT_DECIDED, PENDING, SCHEDULED, SCHEDULED_BLOCKED, REVIEW_DUE, REVIEW_OVERDUE, REQUEST_REVIEW or HOUSEHOLD_SIZE_PENDING. */
    kind         : String(30);
    /** APPLICABILITY, TARGET or PHASE for decision items. */
    decisionKind : String(20);
    campID       : UUID;
    campName     : String(100);
    standardCode : String(12);
    standardName : String(111);
    decisionID   : UUID;
    requestID    : UUID;
    /** Effective, review or flag date that matters for the item. */
    date         : Date;
    /** Why a request needs review, in words (B4.3: what changed, with the requirement before and after). */
    reason       : String(400);
    /** A household-size proposal waiting for approval (kind HOUSEHOLD_SIZE_PENDING). */
    proposalID   : UUID;
  }

  /** One thing to act on now in an active camp (UX-08). */
  type ActNowItem {
    /** CRITICAL_GAP, OVERDUE_DELIVERY or UNANSWERED_REQUEST. */
    kind         : String(20);
    campID       : UUID;
    campName     : String(100);
    standardName : String(111);
    unit         : String(30);
    /** Days of supply left (consumables) or percentage of the requirement (infrastructure), for a critical gap. */
    daysOfCover  : Decimal(10, 1);
    coveragePct  : Decimal(10, 1);
    quantity     : Decimal(15, 1);
    donor        : String(120);
    /** The expected arrival (overdue delivery) or the needed-by date (unanswered request). */
    date         : Date;
    pledgeID     : UUID;
    requestID    : UUID;
  }

  /**
   * UX-08: critical gaps by time to stock-out, deliveries past their expected date, and
   * requests nobody pledged to whose needed-by date has passed. Facts only; there is no
   * stale-count threshold (planning decision B3).
   */
  function actNow() returns many ActNowItem;

  /** Applicability and local target items that need attention across active camps. */
  function attention() returns many AttentionItem;

  /** One local target decision, for the Command Center (B4.2). */
  type LocalTargetItem {
    decisionID         : UUID;
    campID             : UUID;
    campName           : String(100);
    standardCode       : String(12);
    standardName       : String(111);
    unit               : String(30);
    basis              : String(12);
    intent             : String(10);
    status             : String(10);
    displayStatus      : String(60);
    targetPerPerson    : Decimal(12, 6);
    referencePerPerson : Decimal(12, 6);
    effectiveFrom      : Date;
    reviewDue          : Date;
    reviewState        : String(20);
  }

  /** Local target decisions of active camps (all but drafts), in force first. */
  function localTargets() returns many LocalTargetItem;

  type Overview {
    activeCamps           : Integer;
    people                : Integer;
    childrenUnder5        : Integer;
    campsInCrisis         : Integer;
    peopleInCrisis        : Integer;
    criticalGaps          : Integer;
    warningGaps           : Integer;
    /** Active camps without people recorded: none of their indicators is assessed. */
    campsNotAssessed      : Integer;
    /** Indicators in assessed active camps whose stock has never been counted. */
    indicatorsNotCounted  : Integer;
    /** Toilet and tap lines in active camps whose functionality is not confirmed (B4.5). */
    indicatorsNotVerified : Integer;
    /** Indicator lines in active camps whose applicability is not decided. */
    decisionsNeeded       : Integer;
    pendingDecisions      : Integer;
    scheduledDecisions    : Integer;
    overdueReviews        : Integer;
    /** Decisions in force whose review is due today (B4.2). */
    reviewsDueToday       : Integer;
    /** Local targets in force, and the active camps that have at least one (B4.2). */
    localTargetsInForce   : Integer;
    campsWithLocalTargets : Integer;
    requestsToReview      : Integer;
    openRequests          : Integer;
    unpledgedQuantityLines: Integer;
    /** Pledges in transit or partly received, for active camps. */
    pledgesInTransit      : Integer;
    /** UX-01: open or partly pledged requests that donors can still pledge to (not under review). */
    requestsAwaitingPledge      : Integer;
    /** UX-01: requests with at least one pledge in transit or partly received. */
    requestsWithIncomingPledges : Integer;
  }

  function overview() returns Overview;
}
