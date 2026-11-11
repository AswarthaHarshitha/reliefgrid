namespace reliefgrid;

using {
  cuid,
  managed,
  sap.common.CodeList
} from '@sap/cds/common';

/**
 * Gap severity, aligned with UI5 criticality values so it can be bound
 * directly to Criticality annotations and ObjectStatus states.
 */
type Severity : Integer enum {
  Critical = 1;
  Warning  = 2;
  Adequate = 3;
}

type Quantity : Decimal(15, 0);

// ---------------------------------------------------------------------------
// Code lists
// ---------------------------------------------------------------------------

entity Sectors : CodeList {
  key code : String(10);
}

entity Hazards : CodeList {
  key code : String(12);
}

entity CampStatus : CodeList {
  key code        : String(10);
      criticality : Integer;
}

entity RequestStatus : CodeList {
  key code        : String(10);
      criticality : Integer;
}

entity Priorities : CodeList {
  key code : Severity;
}

entity PledgeStatus : CodeList {
  key code        : String(10);
      criticality : Integer;
}

/** Lifecycle of a camp decision (B4.1). */
entity DecisionStatus : CodeList {
  key code        : String(10);
      criticality : Integer;
}

/** Applicability options for a proposal (B4.1); an explicit choice, never an empty value. */
entity ApplicabilityOptions : CodeList {
  key code : String(20);
}

/** What a coordinator may do with a request under review (B4.1). */
entity ReviewResolutions : CodeList {
  key code : String(10);
}

/** Response phases (B4.4): the context a phase-dependent figure (toilets) applies to. */
entity ResponsePhases : CodeList {
  key code : String(12);
}

/** Outcome of the periodic review of a decision in force (B4.2): confirmed until a new date, or a change proposed. */
entity ReviewOutcomes : CodeList {
  key code : String(20);
}

/** Condition of goods at a receipt (ARCH-03). */
entity ReceiptConditions : CodeList {
  key code : String(10);
}

/** Outcome of reviewing a request flagged by an applicability change (B4.1). */
entity RequestReviewStates : CodeList {
  key code        : String(20);
      criticality : Integer;
}

/**
 * Reference indicators: selected Sphere Handbook (2018) figures and ReliefGrid
 * planning assumptions. The methodology page records which is which.
 *
 * Consumption standards are used up every day: `perPerson` is the daily
 * amount one person needs, and stock is measured in days of cover.
 * Coverage standards are infrastructure or durable items: `perPerson` is the
 * number of units one person needs, and stock is measured as % coverage.
 */
entity Standards : CodeList {
  key code      : String(12);
      sector    : Association to Sectors;
      unit      : String(30);
      basis     : String(12) enum {
        Consumption;
        Coverage;
      };
      /** Empty when ReliefGrid has no approved requirement for the indicator (mosquito nets). */
      perPerson : Decimal(12, 6);
      /** Set when the requirement is per household (water containers, B4.3); perPerson then stays only as the baseline a local target replaces. */
      perHousehold : Decimal(12, 6);
      /** Set when the figure depends on the response phase (toilets, B4.4): the figure for the first phase of a rapid-onset crisis. perPerson is the medium-term figure. */
      perPersonFirstPhase : Decimal(12, 6);
      firstPhaseReference : String(300);
      /** Toilets and taps (B4.5): counted as total units and functional units; only functional units meet the requirement. */
      countsFunctional : Boolean default false;
      /** What a counted unit is assumed to provide (taps: 7.5 litres per minute), shown wherever the indicator appears. */
      countingAssumption : String(200);
      /**
       * Food energy planning (B5, decision D10 option A): the energy a person needs per day
       * (2,100 kcal, Sphere). The requirement in units is people x this / the energy of one unit.
       */
      kcalPerPersonDay   : Integer;
      /** The energy of one unit assumed until a camp records its own (ReliefGrid planning assumption). */
      defaultKcalPerUnit : Integer;
      reference : String(300);
      sortOrder : Integer;
      /** ALWAYS: applies unless an approved decision says otherwise. DECISION_REQUIRED: needs an approved decision per camp. */
      applicability : String(20) enum {
        ALWAYS;
        DECISION_REQUIRED;
      } default 'ALWAYS';
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

entity Camps : cuid, managed {
  name           : String(100) @mandatory;
  district       : String(80)  @mandatory;
  region         : String(80)  @mandatory;
  latitude       : Decimal(9, 6);
  longitude      : Decimal(9, 6);
  hazard         : Association to Hazards    @mandatory;
  status         : Association to CampStatus default 'ACTIVE';
  /** People sheltered. Empty when not yet recorded; empty or 0 means the camp is not assessed. */
  headcount      : Integer                   @assert.range: [0, 1000000];
  childrenUnder5 : Integer default 0         @assert.range: [0, 1000000];
  /** Households actually counted (B4.3). Empty when not counted; an estimate is never stored here. */
  households     : Integer                   @assert.range: [1, 1000000];
  /** Energy of one ration pack issued in this camp, in kcal (B5). Empty: the ReliefGrid planning assumption applies, labelled assumed. */
  rationKcalPerPack : Integer                @assert.range: [1, 1000000];
  coordinator    : String(100);
  contactPhone   : String(30);
  openedOn       : Date default $now;
  stock          : Association to many Stock on stock.camp = $self;
  requests       : Association to many Requests on requests.camp = $self;
  /** Stock ledger and supply audit trail of this camp (ARCH-05); no column. */
  movements      : Association to many StockMovements on movements.camp = $self;
  receipts       : Association to many DeliveryReceipts on receipts.camp = $self;
  events         : Association to many AuditEvents on events.campID = ID;
  health         : Association to one CampHealth on health.campID = ID;
  /** The current planning settings; no column (used for the Raise Requests default). */
  settings       : Association to one PlanningSettings on settings.ID = 'CURRENT';
  /** The household planning assumption; no column. */
  householdAssumption : Association to one HouseholdAssumption on householdAssumption.ID = 'CURRENT';
  /** Recorded and estimated households, kept apart; no column. */
  householdInfo  : Association to one CampHouseholds on householdInfo.campID = ID;
  /** The response-phase decision in force (B4.4); no column. Without one the camp is in the medium term, by default. */
  phaseDecision  : Association to one CampDecisions
                     on phaseDecision.camp = $self and phaseDecision.kind = 'PHASE'
                     and phaseDecision.status.code = 'APPROVED' and phaseDecision.intent = 'DECIDE';
  phaseInfo      : Association to one CampPhases on phaseInfo.campID = ID;
  decisions      : Association to many CampDecisions on decisions.camp = $self;
  /** Assessment history of this camp, read-only; no column. */
  assessmentRecords : Association to many AssessmentRecords on assessmentRecords.camp = $self;
}

/**
 * ReliefGrid's operational planning choices: one authoritative record
 * (ID 'CURRENT'). None of these figures is a Sphere requirement. Only
 * Administrators change it, through ReliefService.PlanningSettings.change,
 * and every change is logged in PlanningSettingsChanges. Comparisons are
 * strict: a line is critical when stock is below criticalDays of supply
 * (or criticalPercent of the requirement), and critical takes precedence.
 */
entity PlanningSettings : managed {
  key ID              : String(10) default 'CURRENT';
      criticalDays    : Decimal(6, 2) not null;
      warningDays     : Decimal(6, 2) not null;
      criticalPercent : Decimal(5, 2) not null;
      warningPercent  : Decimal(5, 2) not null;
      targetDays      : Integer not null;
      /** Raised by every change; a change must name the version it was based on. */
      version         : Integer not null default 1;
}

/**
 * The household planning assumption (B4.3): one record (ID 'CURRENT'), used only
 * to estimate households where none were counted. A ReliefGrid planning choice,
 * not a Sphere figure, and deliberately separate from the planning settings.
 */
entity HouseholdAssumption : managed {
  key ID              : String(10) default 'CURRENT';
      householdSize   : Decimal(4, 1) not null;
      /** Raised by every change; a change must name the version it was based on. */
      version         : Integer not null default 1;
      /** The proposal waiting for a second Administrator (B4.3 governance); at most one at a time. */
      pendingProposal : Association to HouseholdSizeProposals;
}

/**
 * Append-only history of the household planning assumption. Since the B4.3
 * governance change, every change is proposed by one Administrator and
 * approved by another: changedAt and changedBy are the approval, proposedAt
 * and proposedBy the proposal. Earlier rows were made by one Administrator
 * alone and have no proposal.
 */
entity HouseholdAssumptionChanges : cuid {
  changedAt    : Timestamp     @mandatory;
  changedBy    : String(255)   @mandatory;
  reason       : String(500)   @mandatory;
  previousSize : Decimal(4, 1);
  newSize      : Decimal(4, 1);
  /** Version of the assumption record that this change produced. */
  version      : Integer;
  /** The proposal this change approved; empty for changes made before two-person approval. */
  proposal     : Association to HouseholdSizeProposals;
  proposedAt   : Timestamp;
  proposedBy   : String(255);
}

/**
 * A proposed household-size change (B4.3 governance). Proposed by one
 * Administrator; approved or rejected by another, or withdrawn by the
 * proposer. Written when proposed and decided once; never deleted.
 */
entity HouseholdSizeProposals : cuid {
  proposedSize   : Decimal(4, 1) @mandatory;
  /** The size in force when proposed. */
  previousSize   : Decimal(4, 1);
  /** Version of the assumption the proposal was based on; approval is refused if it moved on. */
  basedOnVersion : Integer       @mandatory;
  reason         : String(500)   @mandatory;
  proposedAt     : Timestamp     @mandatory;
  proposedBy     : String(255)   @mandatory;
  /** PENDING, APPROVED, REJECTED or WITHDRAWN. */
  status         : String(12)    @mandatory default 'PENDING';
  statusText     : String(30) = case status
                                  when 'PENDING' then 'Waiting for approval'
                                  when 'APPROVED' then 'Approved'
                                  when 'REJECTED' then 'Rejected'
                                  when 'WITHDRAWN' then 'Withdrawn'
                                end;
  decidedAt      : Timestamp;
  decidedBy      : String(255);
  /** Required when rejected; optional otherwise. */
  decisionReason : String(500);
  /** The assumption version an approval produced. */
  resultingVersion : Integer;
}

/** Append-only history: who changed the planning settings, when, why, from what to what. */
entity PlanningSettingsChanges : cuid {
  changedAt               : Timestamp   @mandatory;
  changedBy               : String(255) @mandatory;
  reason                  : String(500) @mandatory;
  previousCriticalDays    : Decimal(6, 2);
  previousWarningDays     : Decimal(6, 2);
  previousCriticalPercent : Decimal(5, 2);
  previousWarningPercent  : Decimal(5, 2);
  previousTargetDays      : Integer;
  newCriticalDays         : Decimal(6, 2);
  newWarningDays          : Decimal(6, 2);
  newCriticalPercent      : Decimal(5, 2);
  newWarningPercent       : Decimal(5, 2);
  newTargetDays           : Integer;
  /** Version of the settings record that this change produced. */
  version                 : Integer;
}

/**
 * A local decision for one camp and indicator. Two kinds, each governed
 * separately: APPLICABILITY (B4.1: whether the indicator applies) and TARGET
 * (B4.2: a local per-person requirement that replaces the reference figure
 * for this camp only; the reference figure itself never changes).
 * Append-only: a submitted proposal is never edited, and an approved decision
 * ends only through a new decision that goes through the same approval.
 * Status moves Draft -> Pending -> Scheduled / In force -> Superseded /
 * Withdrawn, or Pending -> Rejected; a proposer may withdraw an unapproved
 * proposal. At most one decision of each kind per camp and indicator is in force.
 */
entity CampDecisions : cuid, managed {
  camp                : Association to Camps     @mandatory;
  kind                : String(20) enum {
    APPLICABILITY;
    TARGET;
    PHASE;
  } default 'APPLICABILITY';
  /** The indicator decided on; empty for a response-phase decision, which is camp-wide (B4.4). */
  standard            : Association to Standards;
  /** DECIDE sets the value; WITHDRAW ends the decision of the same kind in force. */
  intent              : String(10) enum {
    DECIDE;
    WITHDRAW;
  } default 'DECIDE';
  /** APPLICABILITY, DECIDE only: true applies, false does not apply. */
  applicable          : Boolean;
  /** TARGET, DECIDE only: the local requirement per person, in the indicator's unit (per day for consumables). */
  targetPerPerson     : Decimal(12, 6);
  /** TARGET: the reference figure when the proposal was made, for comparison. */
  referencePerPerson  : Decimal(12, 6);
  /** The decision of the same kind in force when this one was proposed, and its value. */
  previousDecision    : Association to CampDecisions;
  previousApplicable  : Boolean;
  previousTargetPerPerson : Decimal(12, 6);
  /** PHASE, DECIDE only: the response phase (B4.4). */
  responsePhase       : String(12) enum {
    FIRST_PHASE;
    MEDIUM_TERM;
  };
  /** PHASE: the phase in force when proposed; empty means the default (medium term, no decision). */
  previousResponsePhase : String(12);
  /** WITHDRAW only: the decision to end. */
  withdraws           : Association to CampDecisions;
  source              : String(300);
  reason              : String(500);
  proposedBy          : String(255);
  proposedAt          : Timestamp;
  reviewDate          : Date;
  /** Empty: effective on approval. A later date schedules the decision. */
  effectiveFrom       : Date;
  version             : Integer default 1;
  status              : Association to DecisionStatus default 'DRAFT';
  approvedBy          : String(255);
  approvedAt          : Timestamp;
  rejectedBy          : String(255);
  rejectedAt          : Timestamp;
  rejectionReason     : String(500);
  inForceFrom         : Timestamp;
  endedAt             : Timestamp;
  /** The decision that superseded or withdrew this one. */
  endedBy             : Association to CampDecisions;
  /** Periodic reviews of this decision while in force (B4.2), newest last. */
  reviews             : Association to many DecisionReviews on reviews.decision = $self;
  /** Outstanding requests for this camp and indicator (impact of a decision). */
  affectedRequests    : Association to many Requests
                          on affectedRequests.camp = camp and affectedRequests.standard = standard
                          and affectedRequests.status.code in ('OPEN', 'PARTIAL', 'PLEDGED');
}

/**
 * Stock on hand at a camp for one reference indicator. Every active camp holds
 * one row per standard; rows are maintained through counts and deliveries,
 * never through the camp edit draft, so a delivery confirmed while a
 * coordinator edits the camp can't be overwritten on save.
 *
 * A line is assessed only when the camp has people recorded (headcount > 0)
 * and the line has been counted (countedAt set by recordCount). Otherwise the
 * requirement, cover, shortfall and severity are empty, never zero or "met":
 *   NOT_ASSESSED  no population recorded, so no per-person requirement
 *   NOT_COUNTED   population known, stock never counted
 *   CRITICAL / ATTENTION / MET  from the counted quantity
 * The states set by applicability decisions (B4.1) come before NOT_COUNTED;
 * an approved local target (B4.2) replaces the reference figure per person.
 */
entity Stock : cuid, managed {
  camp        : Association to Camps;
  standard    : Association to Standards;
  /** The current planning settings; no column, a join on the single record. */
  settings    : Association to one PlanningSettings on settings.ID = 'CURRENT';
  /** The applicability decision in force for this camp and indicator, if any; no column. */
  applicability : Association to one CampDecisions
                    on applicability.camp = camp and applicability.standard = standard and applicability.kind = 'APPLICABILITY'
                    and applicability.status.code = 'APPROVED' and applicability.intent = 'DECIDE';
  /** The local target decision in force for this camp and indicator, if any (B4.2); no column. */
  target        : Association to one CampDecisions
                    on target.camp = camp and target.standard = standard and target.kind = 'TARGET'
                    and target.status.code = 'APPROVED' and target.intent = 'DECIDE';
  /** Empty until the first count; 0 only when a count found none. For toilets and taps: the total units recorded. */
  quantity    : Quantity;
  countedAt   : Timestamp;
  /** Toilets and taps (B4.5): units confirmed as functional at the last count; empty means functionality not confirmed. */
  functionalUnits : Quantity;

  /** The quantity that meets the requirement: functional units where they are confirmed, otherwise the count. */
  measuredQuantity : Quantity = case
                                  when standard.countsFunctional = true and functionalUnits is not null then functionalUnits
                                  else quantity
                                end;
  /** Toilets and taps: Confirmed or Not confirmed once counted; empty for every other indicator. */
  functionalityText : String(20) = case
                                     when standard.countsFunctional = true and quantity is not null and functionalUnits is null then 'Not confirmed'
                                     when standard.countsFunctional = true and functionalUnits is not null then 'Confirmed'
                                   end;
  nonFunctionalUnits : Quantity = case
                                    when standard.countsFunctional = true and functionalUnits is not null then quantity - functionalUnits
                                  end;

  /** The reference figure per person (never changed by a local target); empty for a line worked out from households. */
  referencePerPerson : Decimal(12, 6) = case
                                          when standard.perHousehold is not null and target.ID is null then null
                                          when (standard.kcalPerPersonDay is not null and standard.perPerson is not null) then case when camp.rationKcalPerPack is not null then standard.kcalPerPersonDay * 1.0 / camp.rationKcalPerPack else standard.kcalPerPersonDay * 1.0 / standard.defaultKcalPerUnit end
                                          when camp.phaseInfo.responsePhase = 'FIRST_PHASE' and standard.perPersonFirstPhase is not null then standard.perPersonFirstPhase
                                          else standard.perPerson
                                        end;
  /**
   * The requirement per person used for this camp: an approved local target in
   * force replaces the reference figure. A local target never creates a
   * requirement where the indicator has no reference figure.
   */
  perPerson   : Decimal(12, 6) = case
                                   when standard.perPerson is null then null
                                   when target.ID is not null then target.targetPerPerson
                                   when standard.perHousehold is not null then null
                                   when (standard.kcalPerPersonDay is not null and standard.perPerson is not null) then case when camp.rationKcalPerPack is not null then standard.kcalPerPersonDay * 1.0 / camp.rationKcalPerPack else standard.kcalPerPersonDay * 1.0 / standard.defaultKcalPerUnit end
                                   when camp.phaseInfo.responsePhase = 'FIRST_PHASE' and standard.perPersonFirstPhase is not null then standard.perPersonFirstPhase
                                   else standard.perPerson
                                 end;
  /**
   * The whole requirement of the line: per person, or for a per-household
   * indicator from recorded or estimated households. An approved local target
   * stays a per-person figure and takes precedence.
   */
  totalRequirement : Decimal(18, 6) = case
                                        when standard.perPerson is null then null
                                        when target.ID is not null then camp.headcount * target.targetPerPerson
                                        when standard.perHousehold is not null then camp.householdInfo.householdsUsed * standard.perHousehold
                                        // B5: people x kcal per person per day / kcal per pack, so cover = packs x kcal / (people x 2,100)
                                        when (standard.kcalPerPersonDay is not null and standard.perPerson is not null) then camp.headcount * case when camp.rationKcalPerPack is not null then standard.kcalPerPersonDay * 1.0 / camp.rationKcalPerPack else standard.kcalPerPersonDay * 1.0 / standard.defaultKcalPerUnit end
                                        when camp.phaseInfo.responsePhase = 'FIRST_PHASE' and standard.perPersonFirstPhase is not null then camp.headcount * standard.perPersonFirstPhase
                                        else camp.headcount * standard.perPerson
                                      end;
  /** REFERENCE_FIGURE, LOCAL_TARGET, HOUSEHOLD, PHASE_FIGURE (first-phase figure, B4.4) or FOOD_ENERGY (B5); empty without a requirement figure. */
  targetBasis : String(20) = case
                               when standard.perPerson is null then null
                               when target.ID is not null then 'LOCAL_TARGET'
                               when standard.perHousehold is not null then 'HOUSEHOLD'
                               when (standard.kcalPerPersonDay is not null and standard.perPerson is not null) then 'FOOD_ENERGY'
                               when camp.phaseInfo.responsePhase = 'FIRST_PHASE' and standard.perPersonFirstPhase is not null then 'PHASE_FIGURE'
                               else 'REFERENCE_FIGURE'
                             end;
  targetBasisText : String(40) = case
                                   when targetBasis = 'FOOD_ENERGY' and camp.rationKcalPerPack is not null then 'Food energy (recorded kcal)'
                                   when targetBasis = 'FOOD_ENERGY' then 'Food energy (assumed kcal)'
                                   when targetBasis = 'LOCAL_TARGET' then 'Local target'
                                   when targetBasis = 'PHASE_FIGURE' then 'First-phase figure'
                                   when targetBasis = 'REFERENCE_FIGURE' and standard.perPersonFirstPhase is not null then 'Medium-term figure'
                                   when targetBasis = 'REFERENCE_FIGURE' then 'Reference figure'
                                   when targetBasis = 'HOUSEHOLD' and camp.householdInfo.householdBasis = 'RECORDED' then 'Households (recorded)'
                                   when targetBasis = 'HOUSEHOLD' and camp.householdInfo.householdBasis = 'ESTIMATED' then 'Households (estimated)'
                                 end;

  assessment  : String(14) = case
                               when camp.headcount is null or camp.headcount <= 0 then 'NOT_ASSESSED'
                               // without planning settings nothing can be classified, and nothing is ever "met"
                               when settings.ID is null then 'NOT_ASSESSED'
                               // a per-household line with neither a count nor a household assumption cannot be worked out
                               when standard.perHousehold is not null and target.ID is null and camp.householdInfo.householdsUsed is null then 'NOT_ASSESSED'
                               when applicability.ID is null and standard.applicability = 'DECISION_REQUIRED' then 'NOT_DECIDED'
                               when applicability.applicable = false then 'NOT_APPLICABLE'
                               when standard.perPerson is null then 'NO_REQUIREMENT'
                               when countedAt is null or quantity is null then 'NOT_COUNTED'
                               // B4.5: from a total alone nothing is declared met or a gap, except a certain crisis:
                               // when even the total is below the critical threshold, functional units can only be fewer
                               when standard.countsFunctional = true and functionalUnits is null and quantity >= totalRequirement * settings.criticalPercent / 100 then 'NOT_VERIFIED'
                               when standard.basis = 'Consumption' then case
                                 when measuredQuantity < totalRequirement * settings.criticalDays then 'CRITICAL'
                                 when measuredQuantity < totalRequirement * settings.warningDays then 'ATTENTION'
                                 else 'MET'
                               end
                               else case
                                 when measuredQuantity < totalRequirement * settings.criticalPercent / 100 then 'CRITICAL'
                                 when measuredQuantity < totalRequirement * settings.warningPercent / 100 then 'ATTENTION'
                                 else 'MET'
                               end
                             end;

  status      : String(60) = case assessment
                               when 'NOT_ASSESSED' then 'Not assessed'
                               when 'NOT_DECIDED' then 'Applicability not decided'
                               when 'NOT_APPLICABLE' then 'Not applicable'
                               when 'NO_REQUIREMENT' then 'Requirement not established'
                               when 'NOT_COUNTED' then 'Not counted'
                               when 'NOT_VERIFIED' then 'Functionality not confirmed'
                               when 'CRITICAL' then case when standard.countsFunctional = true and functionalUnits is null then 'Critical (functionality not confirmed)' else 'Critical' end
                               when 'ATTENTION' then 'Needs attention'
                               when 'MET' then 'Met'
                             end;

  /** Empty unless the camp has people and the indicator applies with an established requirement. */
  required    : Decimal(15, 1) = case
                                   when assessment in ('NOT_COUNTED', 'NOT_VERIFIED', 'CRITICAL', 'ATTENTION', 'MET')
                                     then totalRequirement
                                 end;

  daysOfCover : Decimal(10, 1) = case
                                   when standard.basis = 'Consumption' and assessment in ('CRITICAL', 'ATTENTION', 'MET')
                                     then round(measuredQuantity * 1.0 / (totalRequirement), 1)
                                 end;

  coveragePct : Decimal(10, 1) = case
                                   when standard.basis = 'Coverage' and assessment in ('CRITICAL', 'ATTENTION', 'MET')
                                     then round(measuredQuantity * 100.0 / (totalRequirement), 1)
                                 end;

  cover       : String(30) = case
                               when assessment = 'NOT_ASSESSED' then 'Not assessed'
                               when assessment = 'NOT_DECIDED' then 'Not decided'
                               when assessment = 'NOT_APPLICABLE' then 'Not applicable'
                               when assessment = 'NO_REQUIREMENT' then 'No requirement'
                               when assessment = 'NOT_COUNTED' then 'Not counted'
                               when assessment = 'NOT_VERIFIED' then 'Not confirmed'
                               when standard.basis = 'Consumption'
                                 then round(measuredQuantity * 1.0 / (totalRequirement), 1) || ' days'
                               else cast(round(measuredQuantity * 100.0 / (totalRequirement), 0) as Integer) || ' %'
                             end;

  /** Unknown (empty) when the line is not assessed or not counted. */
  shortfall   : Decimal(15, 1) = case
                             when assessment not in ('CRITICAL', 'ATTENTION', 'MET') then null
                             when standard.basis = 'Consumption' and measuredQuantity < totalRequirement * settings.targetDays
                               then totalRequirement * settings.targetDays - measuredQuantity
                             when standard.basis = 'Coverage' and measuredQuantity < totalRequirement
                               then totalRequirement - measuredQuantity
                             else 0
                           end;

  /** 1 critical, 2 needs attention, 3 met; empty when not assessed or not counted. */
  severity    : Severity = case assessment
                             when 'CRITICAL' then 1
                             when 'ATTENTION' then 2
                             when 'MET' then 3
                           end;
}

entity Requests : cuid, managed {
  camp              : Association to Camps     @mandatory;
  standard          : Association to Standards @mandatory;
  quantity          : Quantity                 @mandatory;
  pledgedQuantity   : Quantity default 0;
  deliveredQuantity : Quantity default 0;
  priority          : Association to Priorities default 2;
  status            : Association to RequestStatus default 'OPEN';
  neededBy          : Date;
  note              : String(500);
  pledges           : Association to many Pledges on pledges.request = $self;
  remaining         : Quantity = case
                                   when quantity > pledgedQuantity then quantity - pledgedQuantity
                                   else 0
                                 end;

  // Calculation basis, recorded when the request is created (B4.0). Requests
  // created earlier have none, and nothing is reconstructed for them.
  /** The assessment this request was calculated from. */
  basisAssessment   : Association to AssessmentRecords;
  /** Requirement of the line at that time, in the indicator's unit. */
  basisRequirement  : Decimal(15, 1);
  /** Where that requirement came from (reference figure and its source). */
  basisSource       : String(400);
  basisSettingsVersion : Integer;
  /** Days of supply the request was raised to reach (automatic requests only). */
  basisTargetDays   : Integer;
  basisCalculatedAt : Timestamp;
  /** True for requests created before calculation bases were recorded. */
  raisedBeforeB4    : Boolean = case when basisAssessment.ID is null then true else false end;

  /** The camp's stock line for this indicator; no column. */
  line              : Association to one Stock on line.camp = camp and line.standard = standard;

  // Review after an applicability change (B4.1). Nothing is cancelled automatically.
  /** State of the current review: Review needed, Kept, Cancelled or Remainder cancelled. */
  review               : Association to RequestReviewStates;
  currentReview        : Association to RequestReviews;
  reviews              : Association to many RequestReviews on reviews.request = $self;
  needsReview          : Boolean = case when review.code = 'PENDING' then true else false end;
}

/**
 * One review of one request, flagged when its indicator stopped being
 * established for the camp (B4.1). Written when flagged and completed once
 * when resolved; never deleted. A request flagged again gets a new review.
 */
entity RequestReviews : cuid {
  request          : Association to Requests @mandatory;
  /** NOT_DECIDED, NOT_APPLICABLE or NO_REQUIREMENT: the state that made the request need a review;
      TARGET_CHANGED: a local target decision changed the requirement per person (B4.2);
      HOUSEHOLDS_CHANGED: a recorded household count changed the requirement (B4.3);
      HOUSEHOLD_SIZE: an approved household-size change changed the requirement (B4.3). */
  cause            : String(20)              @mandatory;
  causeText        : String(40) = case cause
                                    when 'NOT_DECIDED' then 'Applicability not decided'
                                    when 'NOT_APPLICABLE' then 'Not applicable'
                                    when 'NO_REQUIREMENT' then 'Requirement not established'
                                    when 'TARGET_CHANGED' then 'Local target changed'
                                    when 'HOUSEHOLDS_CHANGED' then 'Households changed'
                                    when 'HOUSEHOLD_SIZE' then 'Household size changed'
                                    when 'PHASE_CHANGED' then 'Response phase changed'
                                    when 'RATION_KCAL' then 'Ration energy changed'
                                  end;
  /** What changed, in words, with the requirement before and after (household causes). */
  detail           : String(400);
  /** The household-size change that caused the review (HOUSEHOLD_SIZE). */
  householdChange  : Association to HouseholdAssumptionChanges;
  /** The decision that caused the review; empty when flagged at the B4.1 upgrade. */
  decision         : Association to CampDecisions;
  flaggedAt        : Timestamp               @mandatory;
  flaggedBy        : String(255)             @mandatory;
  resolution       : Association to RequestReviewStates default 'PENDING';
  resolvedAt       : Timestamp;
  resolvedBy       : String(255);
  resolutionReason : String(500);
}

/**
 * One periodic review of a decision in force (B4.2). Append-only. Reviewing
 * confirms the decision until a new review date, or records that a change
 * (a replacement or a withdrawal, through the normal approval) was proposed.
 * A review never changes the decision's value and never approves anything.
 */
entity DecisionReviews : cuid {
  decision          : Association to CampDecisions @mandatory;
  reviewedAt        : Timestamp                    @mandatory;
  reviewedBy        : String(255)                  @mandatory;
  outcome           : Association to ReviewOutcomes @mandatory;
  explanation       : String(500)                  @mandatory;
  /** CONFIRMED: the next review date (required, after today). */
  nextReviewDate    : Date;
  /** CHANGE_PROPOSED: the proposal (same camp, indicator and kind) that would replace or withdraw the decision. */
  resultingDecision : Association to CampDecisions;
  /** Version of the decision this review was made on. */
  decisionVersion   : Integer;
}

entity Pledges : cuid, managed {
  request          : Association to Requests;
  donor            : String(120) @mandatory;
  donorContact     : String(120);
  quantity         : Quantity    @mandatory;
  receivedQuantity : Quantity default 0;
  eta              : Date;
  status           : Association to PledgeStatus default 'PLEDGED';
  /**
   * Usable quantity accepted over all receipts (ARCH-03); damaged or rejected goods are received but not
   * accepted. Empty for deliveries recorded before receipts existed: it was not recorded then.
   */
  acceptedQuantity : Quantity;
  /** Set when a coordinator closed the pledge before the full quantity arrived (ARCH-03). */
  closedAt         : Timestamp;
  closedBy         : String(255);
  closeReason      : String(500);
  receipts         : Association to many DeliveryReceipts on receipts.pledge = $self;
  /** What a donor is told about a pledge whose camp closed or whose request was cancelled (UX-14). */
  situation        : String(40) = case
                                    when request.camp.status.code = 'CLOSED' then 'Camp closed'
                                    when request.status.code = 'CANCELLED' then 'Request cancelled'
                                  end;
}

/**
 * One arrival of goods for a pledge (ARCH-02, ARCH-03). Append-only. A pledge
 * can arrive in several shipments; damaged or rejected goods are received but
 * not accepted, and only accepted goods are added to usable stock.
 */
entity DeliveryReceipts : cuid {
  pledge           : Association to Pledges  @mandatory;
  request          : Association to Requests;
  camp             : Association to Camps;
  receivedAt       : Timestamp               @mandatory;
  receivedBy       : String(255)             @mandatory;
  receivedQuantity : Quantity                @mandatory;
  /** The usable part of the received quantity; it is what is added to stock. */
  acceptedQuantity : Quantity                @mandatory;
  /** GOOD, DAMAGED or REJECTED. */
  condition        : String(10)              @mandatory;
  conditionText    : String(20) = case condition
                                    when 'GOOD' then 'Good'
                                    when 'DAMAGED' then 'Damaged'
                                    when 'REJECTED' then 'Rejected'
                                  end;
  /** Required for damaged or rejected goods and for more than was pledged. */
  reason           : String(500);
  /** More arrived in total than was pledged (ARCH-02). */
  overReceipt      : Boolean default false;
  /** The camp was already closed when the goods arrived (ARCH-06: recorded as a late delivery). */
  afterClosure     : Boolean default false;
}

/**
 * Append-only stock ledger (ARCH-05): every change of a stock line, with the
 * quantity before and after, who made it, when and why. The line's quantity is
 * kept in step with its latest movement in the same transaction.
 */
entity StockMovements : cuid {
  stock            : Association to Stock    @mandatory;
  camp             : Association to Camps;
  standardCode     : String(12);
  movedAt          : Timestamp               @mandatory;
  movedBy          : String(255)             @mandatory;
  /** COUNT (a stock count replaced the quantity) or RECEIPT (accepted goods were added). */
  kind             : String(10)              @mandatory;
  kindText         : String(20) = case kind
                                    when 'COUNT' then 'Stock count'
                                    when 'RECEIPT' then 'Goods received'
                                  end;
  quantityBefore   : Quantity;
  quantityAfter    : Quantity;
  /** The accepted quantity of a receipt; for a count, the difference to the quantity before (empty when it was not counted). */
  change           : Quantity;
  functionalBefore : Quantity;
  functionalAfter  : Quantity;
  receipt          : Association to DeliveryReceipts;
  note             : String(500);
}

/**
 * Append-only audit trail (ARCH-05) for supply operations that are not kept in
 * a history of their own: pledges, withdrawals, receipts, closed pledges,
 * cancelled and raised requests, closed and deleted camps.
 */
entity AuditEvents : cuid {
  occurredAt : Timestamp   @mandatory;
  actor      : String(255) @mandatory;
  kind       : String(30)  @mandatory;
  kindText   : String(40) = case kind
                              when 'PLEDGE_MADE' then 'Pledge made'
                              when 'PLEDGE_WITHDRAWN' then 'Pledge withdrawn'
                              when 'PLEDGE_CLOSED' then 'Pledge closed'
                              when 'RECEIPT_RECORDED' then 'Goods received'
                              when 'REQUEST_CREATED' then 'Request created'
                              when 'REQUESTS_RAISED' then 'Requests raised'
                              when 'REQUEST_CANCELLED' then 'Request cancelled'
                              when 'CAMP_CLOSED' then 'Camp closed'
                              when 'CAMP_DELETED' then 'Camp deleted'
                            end;
  /** Kept as plain values, so an event outlives what it describes. */
  campID     : UUID;
  campName   : String(100);
  requestID  : UUID;
  pledgeID   : UUID;
  detail     : String(500);
}

// ---------------------------------------------------------------------------
// Assessment history (append-only)
// ---------------------------------------------------------------------------

/**
 * What ReliefGrid calculated for one camp at one moment, and from which inputs.
 * Written in the same transaction as the operation that caused it; never
 * updated or deleted. Every value is copied, so a record still explains its
 * result after the live camp, stock, reference data or settings change.
 */
entity AssessmentRecords : cuid {
  camp            : Association to Camps @mandatory;
  assessedAt      : Timestamp            @mandatory;
  /** STOCK_COUNTED, DELIVERY_CONFIRMED, CAMP_REGISTERED, POPULATION_CHANGED, SETTINGS_CHANGED,
      SETTINGS_INITIALISED, REFERENCE_DATA_CHANGED, REQUESTS_RAISED, REQUEST_SUBMITTED, BASELINE,
      DECISION_EFFECTIVE (applicability or local target), HOUSEHOLDS_CHANGED,
      HOUSEHOLD_ASSUMPTION_CHANGED, HOUSEHOLD_ASSUMPTION_INITIALISED */
  trigger         : String(30)           @mandatory;
  /** The business record that caused it (stock line, pledge, settings change, request), where there is one. */
  triggerID       : String(36);
  /** Human-readable note, e.g. 'Baseline at B4 upgrade'. */
  label           : String(100);
  /** User who caused it, or 'system' for start-up events. */
  actor           : String(255);
  campName        : String(100);
  campStatus      : String(10);
  /** Population used (empty: not recorded). */
  headcount       : Integer;
  settingsVersion : Integer;
  criticalDays    : Decimal(6, 2);
  warningDays     : Decimal(6, 2);
  criticalPercent : Decimal(5, 2);
  warningPercent  : Decimal(5, 2);
  targetDays      : Integer;
  /** Households as they were (B4.3): counted, or estimated, never both, and the assumption behind an estimate. */
  recordedHouseholds  : Integer;
  estimatedHouseholds : Integer;
  householdBasis      : String(10);
  householdSize       : Decimal(4, 1);
  householdAssumptionVersion : Integer;
  /** The response phase used (B4.4), whether it was decided or the default, and the decision. */
  responsePhase        : String(12);
  responsePhaseBasis   : String(10);
  phaseDecisionID      : String(36);
  phaseDecisionVersion : Integer;
  /** Food energy (B5): kcal per ration pack used, and whether the camp recorded it or the planning assumption applied. */
  rationKcalPerPack    : Integer;
  rationKcalBasis      : String(10);
  lines           : Composition of many AssessmentRecordLines on lines.record = $self;
  triggerText     : String(40) = case trigger
                                   when 'STOCK_COUNTED' then 'Stock counted'
                                   when 'DELIVERY_CONFIRMED' then 'Delivery confirmed'
                                   when 'CAMP_REGISTERED' then 'Camp registered'
                                   when 'POPULATION_CHANGED' then 'Population changed'
                                   when 'SETTINGS_CHANGED' then 'Planning settings changed'
                                   when 'SETTINGS_INITIALISED' then 'Planning settings created'
                                   when 'REFERENCE_DATA_CHANGED' then 'Reference data changed'
                                   when 'REQUESTS_RAISED' then 'Requests raised'
                                   when 'REQUEST_SUBMITTED' then 'Request submitted'
                                   when 'BASELINE' then 'Baseline'
                                   when 'DECISION_EFFECTIVE' then 'Decision took effect'
                                   when 'HOUSEHOLDS_CHANGED' then 'Households changed'
                                   when 'HOUSEHOLD_ASSUMPTION_CHANGED' then 'Household size changed'
                                   when 'HOUSEHOLD_ASSUMPTION_INITIALISED' then 'Household size created'
                                   when 'RATION_ENERGY_CHANGED' then 'Ration energy changed'
                                 end;
}

/** One indicator line of an assessment record, with its inputs and result as they were. */
entity AssessmentRecordLines : cuid {
  record          : Association to AssessmentRecords @mandatory;
  standardCode    : String(12);
  standardName    : String(111);
  /** Consumption or Coverage. */
  basis           : String(12);
  unit            : String(30);
  /** Requirement per person used for the requirement (the local target when one was in force). */
  perPerson       : Decimal(12, 6);
  /** Basis of the requirement: REFERENCE_FIGURE, LOCAL_TARGET (B4.2), HOUSEHOLD (B4.3) or PHASE_FIGURE (B4.4). */
  requirementBasis : String(20);
  /** Citation of the reference figure at that time (the reference figure, also when a local target was used). */
  requirementSource : String(300);
  /** The reference figure per person at that time (B4.2; empty in earlier records, where perPerson is the reference figure). */
  referencePerPerson : Decimal(12, 6);
  /** The requirement per household, for a line worked out from households (B4.3). */
  perHousehold : Decimal(12, 6);
  /** The local target decision in force, copied: ID, version, effective date and source (B4.2). */
  targetDecisionID      : String(36);
  targetDecisionVersion : Integer;
  targetEffectiveFrom   : Date;
  targetSource          : String(300);
  /** ALWAYS or DECISION_REQUIRED, as the indicator was defined at that time (B4.1). */
  applicabilityRule : String(20);
  /** The applicability decision in force, copied: ID, version and value (B4.1). */
  applicabilityDecisionID      : String(36);
  applicabilityDecisionVersion : Integer;
  applicable      : Boolean;
  quantity        : Quantity;
  countedAt       : Timestamp;
  /** Toilets and taps (B4.5): functional units at the time, and whether functionality was confirmed. */
  functionalUnits        : Quantity;
  functionalityConfirmed : Boolean;
  /** Food energy (B5): kcal per person per day and kcal per unit the requirement was worked out with. */
  kcalPerPersonDay       : Integer;
  kcalPerUnit            : Integer;
  /** NOT_ASSESSED, NOT_DECIDED, NOT_APPLICABLE, NO_REQUIREMENT, NOT_COUNTED, NOT_VERIFIED (B4.5), CRITICAL, ATTENTION or MET. */
  state           : String(14);
  severity        : Integer;
  requirement     : Decimal(15, 1);
  daysOfCover     : Decimal(10, 1);
  coveragePct     : Decimal(10, 1);
  shortfall       : Decimal(15, 1);
  stateText       : String(30) = case state
                                   when 'NOT_ASSESSED' then 'Not assessed'
                                   when 'NOT_DECIDED' then 'Applicability not decided'
                                   when 'NOT_APPLICABLE' then 'Not applicable'
                                   when 'NO_REQUIREMENT' then 'Requirement not established'
                                   when 'NOT_COUNTED' then 'Not counted'
                                   when 'NOT_VERIFIED' then 'Functionality not confirmed'
                                   when 'CRITICAL' then 'Critical'
                                   when 'ATTENTION' then 'Needs attention'
                                   when 'MET' then 'Met'
                                 end;
  requirementBasisText : String(30) = case requirementBasis
                                        when 'LOCAL_TARGET' then 'Local target'
                                        when 'REFERENCE_FIGURE' then 'Reference figure'
                                        when 'HOUSEHOLD' then 'Households'
                                        when 'PHASE_FIGURE' then 'First-phase figure'
                                        when 'FOOD_ENERGY' then 'Food energy'
                                      end;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * One row per camp: the response phase in force (B4.4). Without an approved
 * decision a camp is in the medium term by default, and says so: the default
 * is never presented as a decision.
 */
entity CampPhases as
  select from Camps {
    key ID as campID,
        case when phaseDecision.ID is not null then phaseDecision.responsePhase else 'MEDIUM_TERM' end as responsePhase : String(12),
        case when phaseDecision.ID is not null then 'DECIDED' else 'DEFAULT' end as responsePhaseBasis : String(10),
        case
          when phaseDecision.responsePhase = 'FIRST_PHASE' then 'First phase of a rapid-onset crisis'
          when phaseDecision.responsePhase = 'MEDIUM_TERM' then 'Medium term'
          else 'Medium term (default, no decision)'
        end as responsePhaseText : String(60),
        phaseDecision.ID as phaseDecisionID : String(36),
        phaseDecision.version as phaseDecisionVersion : Integer,
        phaseDecision.inForceFrom as phaseInForceFrom : Timestamp
  };

/**
 * One row per camp: households counted, or estimated from the headcount and
 * the household planning assumption, rounded up (B4.3). An estimate is never
 * presented as a count: recorded and estimated are separate fields.
 * Rounding works on whole tenths of a person, because the size has one
 * decimal and binary fractions would round 115 / 4.6 up to 26.
 */
entity CampHouseholds as
  select from Camps {
    key ID as campID,
        households as recordedHouseholds : Integer,
        case when households is null and headcount > 0 and householdAssumption.householdSize > 0 then cast(headcount * 10.0 / cast(round(householdAssumption.householdSize * 10, 0) as Integer) as Integer) + case when cast(headcount * 10.0 / cast(round(householdAssumption.householdSize * 10, 0) as Integer) as Integer) * cast(round(householdAssumption.householdSize * 10, 0) as Integer) < headcount * 10 then 1 else 0 end end as estimatedHouseholds : Integer,
        case
          when households is not null then households
          when headcount > 0 and householdAssumption.householdSize > 0 then cast(headcount * 10.0 / cast(round(householdAssumption.householdSize * 10, 0) as Integer) as Integer) + case when cast(headcount * 10.0 / cast(round(householdAssumption.householdSize * 10, 0) as Integer) as Integer) * cast(round(householdAssumption.householdSize * 10, 0) as Integer) < headcount * 10 then 1 else 0 end
        end as householdsUsed : Integer,
        case
          when households is not null then 'RECORDED'
          when headcount > 0 and householdAssumption.householdSize > 0 then 'ESTIMATED'
        end as householdBasis : String(10),
        case
          when households is not null then 'Recorded'
          when headcount > 0 and householdAssumption.householdSize > 0 then 'Estimated'
        end as householdBasisText : String(20),
        householdAssumption.householdSize as householdSize : Decimal(4, 1),
        householdAssumption.version as householdAssumptionVersion : Integer
  };

/**
 * One row per camp. Only assessed lines count: "Applicable Indicators Met"
 * is met lines / assessed lines, and is empty when nothing is assessed.
 */
entity CampHealth as
  select from Stock {
    key camp.ID                                                       as campID,
        min(severity)                                                 as worstSeverity       : Severity,
        sum(case when severity = 1 then 1 else 0 end)                 as criticalGaps        : Integer,
        sum(case when severity = 2 then 1 else 0 end)                 as warningGaps         : Integer,
        sum(case when severity = 3 then 1 else 0 end)                 as metIndicators       : Integer,
        count(severity)                                               as assessedIndicators  : Integer,
        sum(case when assessment = 'NOT_COUNTED' then 1 else 0 end)   as notCountedIndicators : Integer,
        sum(case when assessment = 'NOT_VERIFIED' then 1 else 0 end)  as notVerifiedIndicators : Integer,
        sum(case when assessment = 'NOT_DECIDED' then 1 else 0 end)   as notDecidedIndicators : Integer,
        sum(case when assessment = 'NOT_APPLICABLE' then 1 else 0 end) as notApplicableIndicators : Integer,
        sum(case when assessment = 'NO_REQUIREMENT' then 1 else 0 end) as noRequirementIndicators : Integer,
        case
          when count(severity) > 0
            then cast(sum(case when severity = 3 then 1 else 0 end) * 100 / count(severity) as Integer)
        end                                                           as compliance          : Integer,
        case
          when max(camp.headcount) is null or max(camp.headcount) <= 0 then 'Not assessed'
          when count(severity) = 0 then 'Not counted'
          when sum(case when assessment = 'NOT_COUNTED' then 1 else 0 end) > 0 then 'Partly counted'
          else 'Assessed'
        end                                                           as assessment          : String(20),
        case when count(severity) = 0 then true else false end        as nothingAssessed     : Boolean
  }
  group by
    camp.ID;
