using reliefgrid as db from '../db/schema';

// Labels, texts and value helps shared by every app and service.

annotate db.Standards with @(
  title             : '{i18n>Standard}',
  Common.SemanticKey: [code]
) {
  code      @title: '{i18n>Standard}'  @Common.Text: name  @Common.TextArrangement: #TextOnly;
  name      @title: '{i18n>Standard}';
  sector    @title: '{i18n>Sector}'    @Common.Text: sector.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  unit      @title: '{i18n>Unit}';
  basis     @title: '{i18n>Basis}';
  perPerson @title: '{i18n>PerPerson}' @Measures.Unit: unit;
  reference @title: '{i18n>Reference}';
}

annotate db.Sectors with {
  code @title: '{i18n>Sector}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.Hazards with {
  code @title: '{i18n>Hazard}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.CampStatus with {
  code @title: '{i18n>Status}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.RequestStatus with {
  code @title: '{i18n>Status}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.Priorities with {
  code @title: '{i18n>Priority}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.PledgeStatus with {
  code @title: '{i18n>Status}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.Camps with {
  ID             @UI.Hidden;
  name           @title: '{i18n>CampName}';
  district       @title: '{i18n>District}';
  region         @title: '{i18n>Region}';
  latitude       @title: '{i18n>Latitude}';
  longitude      @title: '{i18n>Longitude}';
  hazard         @title: '{i18n>Hazard}'   @Common.Text: hazard.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  status         @title: '{i18n>Status}'   @Common.Text: status.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues  @readonly;
  headcount      @title: '{i18n>Headcount}';
  childrenUnder5 @title: '{i18n>ChildrenUnder5}';
  coordinator    @title: '{i18n>Coordinator}';
  contactPhone   @title: '{i18n>ContactPhone}' @Communication.IsPhoneNumber;
  openedOn       @title: '{i18n>OpenedOn}';
}

annotate db.CampHealth with {
  campID        @UI.Hidden;
  worstSeverity @title: '{i18n>WorstSeverity}';
  criticalGaps  @title: '{i18n>CriticalGaps}';
  warningGaps   @title: '{i18n>WarningGaps}';
  compliance    @title: '{i18n>Compliance}' @Measures.Unit: '%' @Common.QuickInfo: '{i18n>ComplianceInfo}';
  metIndicators        @title: '{i18n>MetIndicators}';
  assessedIndicators   @title: '{i18n>AssessedIndicators}';
  notCountedIndicators @title: '{i18n>NotCountedIndicators}';
  assessment    @title: '{i18n>CampAssessment}';
  nothingAssessed @UI.Hidden;
}

annotate db.Stock with {
  ID          @UI.Hidden;
  camp        @UI.Hidden;
  standard    @title: '{i18n>Standard}'    @Common.Text: standard.name  @Common.TextArrangement: #TextOnly;
  quantity    @title: '{i18n>OnHand}'      @Measures.Unit: standard.unit;
  required    @title: '{i18n>Required}'    @Measures.Unit: standard.unit  @Common.QuickInfo: '{i18n>RequiredInfo}';
  cover       @title: '{i18n>Cover}'       @Common.QuickInfo: '{i18n>CoverInfo}';
  shortfall   @title: '{i18n>Shortfall}'   @Measures.Unit: standard.unit;
  daysOfCover @title: '{i18n>DaysOfCover}';
  coveragePct @title: '{i18n>CoveragePct}';
  severity    @title: '{i18n>Severity}';
  countedAt   @title: '{i18n>CountedAt}';
  status      @title: '{i18n>IndicatorStatus}';
  assessment  @title: '{i18n>IndicatorStatus}' @UI.Hidden;
  perPerson          @title: '{i18n>EffectivePerPerson}'  @Measures.Unit: standard.unit;
  functionalUnits    @title: '{i18n>FunctionalUnits}'     @Measures.Unit: standard.unit;
  functionalityText  @title: '{i18n>Functionality}';
  nonFunctionalUnits @title: '{i18n>NonFunctionalUnits}'  @Measures.Unit: standard.unit;
  measuredQuantity   @UI.Hidden;
  referencePerPerson @title: '{i18n>ReferencePerPerson}'  @Measures.Unit: standard.unit;
  targetBasis        @UI.Hidden;
  targetBasisText    @title: '{i18n>TargetBasis}';
  target             @UI.Hidden;
  applicability      @UI.Hidden;
}

annotate db.Requests with {
  ID                @UI.Hidden;
  camp              @title: '{i18n>Camp}'      @Common.Text: camp.name  @Common.TextArrangement: #TextOnly;
  standard          @title: '{i18n>Standard}'  @Common.Text: standard.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  quantity          @title: '{i18n>Quantity}'  @Measures.Unit: standard.unit;
  pledgedQuantity   @title: '{i18n>Pledged}'   @Measures.Unit: standard.unit;
  deliveredQuantity @title: '{i18n>Delivered}' @Measures.Unit: standard.unit;
  remaining         @title: '{i18n>Remaining}' @Measures.Unit: standard.unit;
  priority          @title: '{i18n>Priority}'  @Common.Text: priority.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  status            @title: '{i18n>Status}'    @Common.Text: status.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  neededBy          @title: '{i18n>NeededBy}';
  note              @title: '{i18n>Note}'      @UI.MultiLineText;
  createdAt         @title: '{i18n>RaisedOn}';
}

annotate db.Pledges with {
  ID               @UI.Hidden;
  request          @UI.Hidden;
  donor            @title: '{i18n>Donor}';
  donorContact     @title: '{i18n>DonorContact}';
  quantity         @title: '{i18n>Quantity}';
  receivedQuantity @title: '{i18n>ReceivedQuantity}';
  eta              @title: '{i18n>Eta}';
  status           @title: '{i18n>Status}' @Common.Text: status.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
}

annotate db.CampDecisions with {
  ID               @UI.Hidden;
  camp             @title: '{i18n>Camp}'          @Common.Text: camp.name  @Common.TextArrangement: #TextOnly;
  kind             @UI.Hidden;
  standard         @title: '{i18n>Standard}'      @Common.Text: standard.name  @Common.TextArrangement: #TextOnly;
  intent           @title: '{i18n>DecisionIntent}';
  applicable       @UI.Hidden;
  previousApplicable @UI.Hidden;
  previousDecision @UI.Hidden;
  withdraws        @UI.Hidden;
  endedBy          @UI.Hidden;
  source           @title: '{i18n>DecisionSource}';
  reason           @title: '{i18n>DecisionReason}'  @UI.MultiLineText;
  proposedBy       @title: '{i18n>ProposedBy}';
  proposedAt       @title: '{i18n>ProposedAt}';
  reviewDate       @title: '{i18n>ReviewDate}';
  effectiveFrom    @title: '{i18n>EffectiveFrom}';
  version          @title: '{i18n>Version}';
  status           @title: '{i18n>DecisionStatus}' @Common.Text: status.name  @Common.TextArrangement: #TextOnly;
  approvedBy       @title: '{i18n>ApprovedBy}';
  approvedAt       @title: '{i18n>ApprovedAt}';
  rejectedBy       @title: '{i18n>RejectedBy}';
  rejectedAt       @title: '{i18n>RejectedAt}';
  rejectionReason  @title: '{i18n>RejectionReason}' @UI.MultiLineText;
  inForceFrom      @title: '{i18n>InForceFrom}';
  endedAt          @title: '{i18n>EndedAt}';
  targetPerPerson  @title: '{i18n>TargetPerPerson}'    @Measures.Unit: standard.unit;
  referencePerPerson @title: '{i18n>ReferencePerPerson}' @Measures.Unit: standard.unit;
  previousTargetPerPerson @title: '{i18n>PreviousTarget}' @Measures.Unit: standard.unit;
  responsePhase    @UI.Hidden;
  previousResponsePhase @UI.Hidden;
}

annotate db.Camps with {
  phaseInfo           @UI.Hidden;
  phaseDecision       @UI.Hidden;
}

annotate db.CampPhases with {
  campID               @UI.Hidden;
  responsePhase        @UI.Hidden;
  responsePhaseBasis   @UI.Hidden;
  responsePhaseText    @title: '{i18n>ResponsePhase}';
  phaseDecisionID      @UI.Hidden;
  phaseDecisionVersion @UI.Hidden;
  phaseInForceFrom     @title: '{i18n>InForceFrom}';
}

annotate db.ResponsePhases with {
  code @title: '{i18n>ResponsePhase}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.Camps with {
  households          @title: '{i18n>Households}';
  rationKcalPerPack   @title: '{i18n>RationKcalPerPack}' @Common.QuickInfo: '{i18n>RationKcalPerPackInfo}' @Measures.Unit: 'kcal';
  householdInfo       @UI.Hidden;
  householdAssumption @UI.Hidden;
}

annotate db.CampHouseholds with {
  campID                     @UI.Hidden;
  recordedHouseholds         @title: '{i18n>Households}';
  estimatedHouseholds        @title: '{i18n>EstimatedHouseholds}';
  householdsUsed             @title: '{i18n>HouseholdsUsed}';
  householdBasis             @UI.Hidden;
  householdBasisText         @title: '{i18n>HouseholdBasis}';
  householdSize              @title: '{i18n>HouseholdSize}';
  householdAssumptionVersion @UI.Hidden;
}

annotate db.AssessmentRecords with {
  recordedHouseholds         @title: '{i18n>Households}';
  estimatedHouseholds        @title: '{i18n>EstimatedHouseholds}';
  householdBasis             @UI.Hidden;
  householdSize              @title: '{i18n>HouseholdSize}';
  householdAssumptionVersion @title: '{i18n>HouseholdAssumptionVersion}';
  responsePhase              @title: '{i18n>ResponsePhase}';
  responsePhaseBasis         @title: '{i18n>ResponsePhaseBasis}';
  phaseDecisionID            @UI.Hidden;
  phaseDecisionVersion       @title: '{i18n>PhaseDecisionVersion}';
  rationKcalPerPack          @title: '{i18n>RationKcalPerPack}' @Measures.Unit: 'kcal';
  rationKcalBasis            @title: '{i18n>RationKcalBasis}';
}

annotate db.AssessmentRecords with {
  ID              @UI.Hidden;
  camp            @UI.Hidden;
  trigger         @UI.Hidden;
  triggerID       @UI.Hidden;
  assessedAt      @title: '{i18n>AssessedAt}';
  triggerText     @title: '{i18n>AssessmentTrigger}';
  label           @title: '{i18n>AssessmentNote}';
  actor           @title: '{i18n>AssessmentActor}';
  campName        @title: '{i18n>Camp}';
  campStatus      @title: '{i18n>Status}';
  headcount       @title: '{i18n>Headcount}';
  settingsVersion @title: '{i18n>SettingsVersion}';
  criticalDays    @title: '{i18n>CriticalDays}';
  warningDays     @title: '{i18n>WarningDays}';
  criticalPercent @title: '{i18n>CriticalPercent}';
  warningPercent  @title: '{i18n>WarningPercent}';
  targetDays      @title: '{i18n>TargetDays}';
}

annotate db.AssessmentRecordLines with {
  ID              @UI.Hidden;
  record          @UI.Hidden;
  standardCode    @UI.Hidden;
  state           @UI.Hidden;
  requirementBasis @UI.Hidden;
  standardName    @title: '{i18n>Standard}';
  stateText       @title: '{i18n>IndicatorStatus}';
  quantity        @title: '{i18n>OnHand}'             @Measures.Unit: unit;
  requirement     @title: '{i18n>Required}'           @Measures.Unit: unit;
  perPerson       @title: '{i18n>EffectivePerPerson}' @Measures.Unit: unit;
  requirementBasisText @title: '{i18n>TargetBasis}';
  referencePerPerson @title: '{i18n>ReferencePerPerson}' @Measures.Unit: unit;
  perHousehold    @title: '{i18n>PerHousehold}'       @Measures.Unit: unit;
  shortfall       @title: '{i18n>Shortfall}'          @Measures.Unit: unit;
  daysOfCover     @title: '{i18n>DaysOfCover}';
  coveragePct     @title: '{i18n>CoveragePct}';
  targetSource    @title: '{i18n>DecisionSource}';
  targetDecisionVersion @title: '{i18n>DecisionVersion}';
  countedAt       @title: '{i18n>CountedAt}';
  functionalUnits @title: '{i18n>FunctionalUnits}'    @Measures.Unit: unit;
  functionalityConfirmed @title: '{i18n>FunctionalityConfirmed}';
  kcalPerPersonDay @title: '{i18n>KcalPerPersonDay}';
  kcalPerUnit     @title: '{i18n>KcalPerUnit}';
}

annotate db.DecisionReviews with {
  ID                @UI.Hidden;
  decision          @UI.Hidden;
  reviewedAt        @title: '{i18n>ReviewedAt}';
  reviewedBy        @title: '{i18n>ReviewedBy}';
  outcome           @title: '{i18n>ReviewOutcome}' @Common.Text: outcome.name  @Common.TextArrangement: #TextOnly;
  explanation       @title: '{i18n>ReviewExplanation}' @UI.MultiLineText;
  nextReviewDate    @title: '{i18n>NextReviewDate}';
  resultingDecision @title: '{i18n>ResultingDecision}';
  decisionVersion   @title: '{i18n>DecisionVersion}';
}

annotate db.RequestReviews with {
  ID               @UI.Hidden;
  request          @UI.Hidden;
  decision         @UI.Hidden;
  cause            @UI.Hidden;
  causeText        @title: '{i18n>ReviewCause}';
  detail           @title: '{i18n>ReviewDetail}' @UI.MultiLineText;
  householdChange  @UI.Hidden;
  flaggedAt        @title: '{i18n>FlaggedAt}';
  flaggedBy        @title: '{i18n>FlaggedBy}';
  resolution       @title: '{i18n>ReviewState}' @Common.Text: resolution.name  @Common.TextArrangement: #TextOnly;
  resolvedAt       @title: '{i18n>ResolvedAt}';
  resolvedBy       @title: '{i18n>ResolvedBy}';
  resolutionReason @title: '{i18n>ReviewReason}' @UI.MultiLineText;
}

annotate db.Requests with {
  review        @title: '{i18n>ReviewState}' @Common.Text: review.name  @Common.TextArrangement: #TextOnly;
  currentReview @UI.Hidden;
  needsReview   @UI.Hidden;
  line          @UI.Hidden;
  basisAssessment @UI.Hidden;
}

annotate db.DecisionStatus with {
  code @title: '{i18n>DecisionStatus}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.RequestReviewStates with {
  code @title: '{i18n>ReviewState}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.ApplicabilityOptions with {
  code @title: '{i18n>Applicability}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.ReviewResolutions with {
  code @title: '{i18n>ReviewResolution}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}

annotate db.ReviewOutcomes with {
  code @title: '{i18n>ReviewOutcome}' @Common.Text: name @Common.TextArrangement: #TextOnly;
}


annotate db.HouseholdSizeProposals with {
  ID               @UI.Hidden;
  proposedSize     @title: '{i18n>ProposedHouseholdSize}';
  previousSize     @title: '{i18n>PreviousHouseholdSize}';
  basedOnVersion   @title: '{i18n>HouseholdAssumptionVersion}';
  reason           @title: '{i18n>ChangeReason}' @UI.MultiLineText;
  proposedAt       @title: '{i18n>ProposedAt}';
  proposedBy       @title: '{i18n>ProposedBy}';
  status           @UI.Hidden;
  statusText       @title: '{i18n>ProposalStatus}';
  decidedAt        @title: '{i18n>DecidedAt}';
  decidedBy        @title: '{i18n>DecidedBy}';
  decisionReason   @title: '{i18n>DecisionReason}';
  resultingVersion @title: '{i18n>HouseholdAssumptionVersion}';
}

// Receipts, stock ledger and audit trail (ARCH-03, ARCH-05)
annotate db.DeliveryReceipts with {
  ID               @UI.Hidden;
  pledge           @UI.Hidden;
  request          @UI.Hidden;
  camp             @UI.Hidden;
  condition        @UI.Hidden;
  receivedAt       @title: '{i18n>ReceivedAt}';
  receivedBy       @title: '{i18n>ReceivedBy}';
  receivedQuantity @title: '{i18n>ReceivedQuantity}';
  acceptedQuantity @title: '{i18n>AcceptedQuantity}';
  conditionText    @title: '{i18n>ReceiptCondition}';
  reason           @title: '{i18n>ReceiptReason}';
  overReceipt      @title: '{i18n>OverReceipt}';
  afterClosure     @title: '{i18n>AfterClosure}';
}

annotate db.StockMovements with {
  ID               @UI.Hidden;
  stock            @UI.Hidden;
  camp             @UI.Hidden;
  kind             @UI.Hidden;
  receipt          @UI.Hidden;
  standardCode     @UI.Hidden;
  functionalBefore @UI.Hidden;
  functionalAfter  @UI.Hidden;
  movedAt          @title: '{i18n>MovedAt}';
  movedBy          @title: '{i18n>MovedBy}';
  kindText         @title: '{i18n>MovementKind}';
  quantityBefore   @title: '{i18n>QuantityBefore}';
  quantityAfter    @title: '{i18n>QuantityAfter}';
  change           @title: '{i18n>QuantityChange}';
  note             @title: '{i18n>MovementNote}';
}

annotate db.AuditEvents with {
  ID         @UI.Hidden;
  kind       @UI.Hidden;
  campID     @UI.Hidden;
  requestID  @UI.Hidden;
  pledgeID   @UI.Hidden;
  campName   @title: '{i18n>Camp}';
  occurredAt @title: '{i18n>OccurredAt}';
  actor      @title: '{i18n>Actor}';
  kindText   @title: '{i18n>EventKind}';
  detail     @title: '{i18n>EventDetail}';
}

annotate db.Pledges with {
  acceptedQuantity @title: '{i18n>AcceptedQuantity}';
  closeReason      @title: '{i18n>ClosePledgeReason}';
  closedAt         @title: '{i18n>ClosedAt}';
  closedBy         @title: '{i18n>ClosedBy}';
  situation        @title: '{i18n>PledgeSituation}';
}
