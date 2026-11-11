using ReliefService as service from '../../srv/relief-service';

// ---------------------------------------------------------------------------
// Camps: list report and object page
// ---------------------------------------------------------------------------

annotate service.Camps with @(
  UI.HeaderInfo                 : {
    TypeName      : '{i18n>Camp}',
    TypeNamePlural: '{i18n>Camps}',
    TypeImageUrl  : 'sap-icon://building',
    Title         : {Value: name},
    Description   : {Value: district}
  },
  UI.SelectionFields            : [
    region,
    district,
    hazard_code,
    status_code
  ],
  UI.PresentationVariant        : {
    SortOrder     : [
      {Property: health.worstSeverity},
      {Property: headcount, Descending: true}
    ],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem                   : [
    {
      Value                : name,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '14rem'}
    },
    {
      Value             : district,
      ![@UI.Importance] : #Medium
    },
    {
      Value             : hazard_code,
      ![@UI.Importance] : #Low
    },
    {
      Value             : headcount,
      ![@UI.Importance]: #High
    },
    {
      $Type             : 'UI.DataFieldForAnnotation',
      Target            : 'health/@UI.DataPoint#Compliance',
      Label             : '{i18n>Compliance}',
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '14rem'}
    },
    {
      Value             : health.assessment,
      ![@UI.Importance] : #High
    },
    {
      Value             : health.criticalGaps,
      Criticality       : health.worstSeverity,
      ![@UI.Importance]: #High
    },
    {
      Value             : status_code,
      Criticality       : status.criticality,
      ![@UI.Importance] : #Medium
    }
  ],
  UI.HeaderFacets               : [
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Headcount'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Children'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: 'health/@UI.DataPoint#Compliance',
      // Nothing assessed: the Assessment field says why instead of an empty percentage.
      ![@UI.Hidden]: health.nothingAssessed
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: 'health/@UI.DataPoint#Critical'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.FieldGroup#Status'
    }
  ],
  UI.DataPoint #Headcount       : {
    Value: headcount,
    Title: '{i18n>Headcount}'
  },
  UI.DataPoint #Children        : {
    Value: childrenUnder5,
    Title: '{i18n>ChildrenUnder5}'
  },
  UI.FieldGroup #Status         : {Data: [
    {
      Value      : status_code,
      Criticality: status.criticality
    },
    {Value: health.assessment},
    {Value: phaseInfo.responsePhaseText},
    {Value: hazard_code},
    {Value: openedOn}
  ]},
  UI.Identification             : [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.requestSupplies',
      Label : '{i18n>RequestSupplies}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.closeCamp',
      Label : '{i18n>CloseCamp}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposeApplicability',
      Label : '{i18n>ProposeApplicability}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposeWithdrawal',
      Label : '{i18n>ProposeWithdrawal}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposeTarget',
      Label : '{i18n>ProposeTarget}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposeTargetWithdrawal',
      Label : '{i18n>ProposeTargetWithdrawal}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposePhase',
      Label : '{i18n>ProposePhase}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.proposePhaseWithdrawal',
      Label : '{i18n>ProposePhaseWithdrawal}'
    }
  ],
  UI.Facets                     : [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Gaps',
      Label : '{i18n>Stock}',
      Target: 'stock/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Requests',
      Label : '{i18n>Requests}',
      Target: 'requests/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Decisions',
      Label : '{i18n>Decisions}',
      Target: 'decisions/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'AssessmentHistory',
      Label : '{i18n>AssessmentHistory}',
      Target: 'assessmentRecords/@UI.PresentationVariant'
    },
    // ARCH-03, ARCH-05, ARCH-06: what arrived, every change of stock, and every supply operation
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Receipts',
      Label : '{i18n>GoodsReceived}',
      Target: 'receipts/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'StockLedger',
      Label : '{i18n>StockLedger}',
      Target: 'movements/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Activity',
      Label : '{i18n>SupplyActivity}',
      Target: 'events/@UI.PresentationVariant'
    },
    {
      $Type : 'UI.CollectionFacet',
      ID    : 'Details',
      Label : 'Camp Details',
      Facets: [
        {
          $Type : 'UI.ReferenceFacet',
          Label : 'Population',
          Target: '@UI.FieldGroup#Population'
        },
        {
          $Type : 'UI.ReferenceFacet',
          Label : 'Location',
          Target: '@UI.FieldGroup#Location'
        },
        {
          $Type : 'UI.ReferenceFacet',
          Label : 'Contact',
          Target: '@UI.FieldGroup#Contact'
        }
      ]
    }
  ],
  UI.FieldGroup #Population     : {Data: [
    {Value: headcount},
    {Value: households},
    // an estimate is shown as such, beside the count and never in its place
    {Value: householdInfo.estimatedHouseholds},
    {Value: householdInfo.householdBasisText},
    {Value: householdInfo.householdSize},
    // food energy (B5): empty means the 2,100 kcal planning assumption applies
    {Value: rationKcalPerPack},
    {Value: childrenUnder5},
    {Value: hazard_code},
    {Value: openedOn}
  ]},
  UI.FieldGroup #Location       : {Data: [
    {Value: name},
    {Value: district},
    {Value: region},
    {Value: latitude},
    {Value: longitude}
  ]},
  UI.FieldGroup #Contact        : {Data: [
    {Value: coordinator},
    {Value: contactPhone}
  ]}
) {
  // Status changes only through the Close Camp action.
  status @Core.Computed;
};

annotate service.Camps actions {
  // The dialog starts at the replenishment target from the planning settings.
  raiseRequests(targetDays @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/settings/targetDays'}});
};

annotate service.Camps actions {
  proposeApplicability @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  proposeWithdrawal @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  proposeTarget @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  proposeTargetWithdrawal @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  proposePhase @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  proposePhaseWithdrawal @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
};

annotate service.Camps actions {
  raiseRequests @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  requestSupplies @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}};
  closeCamp @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'ACTIVE']}}
            @Common.IsActionCritical;
};

annotate service.CampHealth with @(
  UI.DataPoint #Compliance: {
    Value        : compliance,
    TargetValue  : 100,
    Visualization: #Progress,
    Criticality  : worstSeverity,
    Title        : '{i18n>Compliance}'
  },
  UI.DataPoint #Critical  : {
    Value      : criticalGaps,
    Criticality: worstSeverity,
    Title      : '{i18n>CriticalGaps}'
  }
);

// ---------------------------------------------------------------------------
// Stock: Sphere gap analysis table
// ---------------------------------------------------------------------------

annotate service.Stock with @(
  UI.PresentationVariant: {
    SortOrder     : [
      {Property: severity},
      {Property: daysOfCover}
    ],
    Visualizations: ['@UI.LineItem']
  },
  // Compact widths and short headers, so every column sits side by side on a desktop screen
  // instead of being pushed into stacked sub-rows. Record Count works on the selected line.
  UI.LineItem           : [
    {
      $Type  : 'UI.DataFieldForAction',
      Action : 'ReliefService.recordCount',
      Label  : '{i18n>RecordCount}'
    },
    {
      Value                 : standard_code,
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '7.5rem'}
    },
    {
      Value                 : status,
      Criticality           : severity,
      CriticalityRepresentation: #WithIcon,
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '8.5rem'}
    },
    {
      Value                 : cover,
      Label                 : '{i18n>ColCover}',
      Criticality           : severity,
      CriticalityRepresentation: #WithoutIcon,
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '6.75rem'}
    },
    {
      Value                 : quantity,
      Label                 : '{i18n>ColOnHand}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '7.75rem'}
    },
    {
      Value                 : functionalUnits,
      Label                 : '{i18n>ColFunctional}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '5.5rem'}
    },
    {
      Value                 : required,
      Label                 : '{i18n>ColRequired}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '8.25rem'}
    },
    {
      Value                 : perPerson,
      Label                 : '{i18n>ColPerPerson}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '7.5rem'}
    },
    {
      Value                 : targetBasisText,
      Label                 : '{i18n>ColBasis}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '6.5rem'}
    },
    {
      Value                 : referencePerPerson,
      Label                 : '{i18n>ColReference}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '7.5rem'}
    },
    {
      Value                 : shortfall,
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '8.5rem'}
    },
    {
      Value                 : countedAt,
      Label                 : '{i18n>ColCounted}',
      ![@UI.Importance]     : #High,
      ![@HTML5.CssDefaults] : {width: '6.5rem'}
    }
  ]
) {
  standard @Core.Immutable;
};

// ---------------------------------------------------------------------------
// Requests and pledges
// ---------------------------------------------------------------------------

annotate service.Requests with @(
  UI.HeaderInfo         : {
    TypeName      : '{i18n>Request}',
    TypeNamePlural: '{i18n>Requests}',
    Title         : {Value: standard_code},
    Description   : {Value: camp_ID}
  },
  UI.PresentationVariant: {
    SortOrder     : [
      {Property: priority_code},
      {Property: neededBy}
    ],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem           : [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.cancel',
      Label : '{i18n>CancelRequest}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.resolveReview',
      Label : '{i18n>ResolveReview}'
    },
    {
      Value                    : priority_code,
      Criticality              : priority_code,
      CriticalityRepresentation: #WithIcon,
      ![@UI.Importance]: #High
    },
    {
      Value             : standard_code,
      ![@UI.Importance]: #High
    },
    {
      Value             : quantity,
      ![@UI.Importance]: #High
    },
    {
      Value             : pledgedQuantity,
      ![@UI.Importance] : #Medium
    },
    {
      Value             : deliveredQuantity,
      ![@UI.Importance] : #Medium
    },
    {
      Value             : neededBy,
      ![@UI.Importance]: #High
    },
    {
      Value             : status_code,
      Criticality       : status.criticality,
      ![@UI.Importance]: #High
    },
    {
      Value                    : review_code,
      Criticality              : review.criticality,
      CriticalityRepresentation: #WithIcon,
      ![@UI.Importance]        : #High
    }
  ],
  UI.HeaderFacets       : [
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Quantity'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Pledged'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Delivered'
    }
  ],
  UI.DataPoint #Quantity: {
    Value: quantity,
    Title: '{i18n>Quantity}'
  },
  UI.DataPoint #Pledged : {
    Value        : pledgedQuantity,
    TargetValue  : quantity,
    Visualization: #Progress,
    Title        : '{i18n>Pledged}'
  },
  UI.DataPoint #Delivered: {
    Value        : deliveredQuantity,
    TargetValue  : quantity,
    Visualization: #Progress,
    Title        : '{i18n>Delivered}'
  },
  UI.Facets             : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Request',
      Target: '@UI.FieldGroup#Request'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Pledges}',
      Target: 'pledges/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Reviews}',
      Target: 'reviews/@UI.LineItem'
    }
  ],
  UI.FieldGroup #Request: {Data: [
    {Value: standard_code},
    {
      Value      : status_code,
      Criticality: status.criticality
    },
    {
      Value      : priority_code,
      Criticality: priority_code
    },
    {Value: neededBy},
    {Value: note},
    {Value: createdAt},
    {
      Value      : review_code,
      Criticality: review.criticality
    }
  ]},
  UI.Identification     : [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.cancel',
      Label : '{i18n>CancelRequest}'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'ReliefService.resolveReview',
      Label : '{i18n>ResolveReview}'
    }
  ]
) {
  camp @Common.Text: camp.name;
};

annotate service.Requests actions {
  // a flagged request is cancelled only through its review, so the reason is recorded
  cancel @Core.OperationAvailable: {$edmJson: {$And: [
    {$Or: [
      {$Eq: [{$Path: 'in/status_code'}, 'OPEN']},
      {$Eq: [{$Path: 'in/status_code'}, 'PARTIAL']}
    ]},
    {$Ne: [{$Path: 'in/needsReview'}, true]}
  ]}} @Common.IsActionCritical;
  resolveReview @Core.OperationAvailable: {$edmJson: {$Path: 'in/needsReview'}};
};

annotate service.RequestReviews with @(UI.LineItem: [
  {Value: flaggedAt},
  {Value: causeText},
  {Value: detail},
  {Value: flaggedBy},
  {
    Value      : resolution_code,
    Criticality: resolution.criticality
  },
  {Value: resolvedAt},
  {Value: resolvedBy},
  {Value: resolutionReason}
]);

// ---------------------------------------------------------------------------
// Applicability decisions (B4.1)
// ---------------------------------------------------------------------------

annotate service.CampDecisions with @(
  UI.HeaderInfo         : {
    TypeName      : '{i18n>Decision}',
    TypeNamePlural: '{i18n>Decisions}',
    Title         : {Value: subjectText},
    Description   : {Value: displayStatus}
  },
  UI.PresentationVariant: {
    SortOrder     : [{Property: createdAt, Descending: true}],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem           : [
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.submit', Label: '{i18n>SubmitDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.approve', Label: '{i18n>ApproveDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.rejectProposal', Label: '{i18n>RejectDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.withdrawProposal', Label: '{i18n>WithdrawProposal}'},
    {
      Value             : standard_code,
      ![@UI.Importance] : #High
    },
    {
      Value             : kindText,
      Label             : '{i18n>DecisionKind}',
      ![@UI.Importance] : #High
    },
    {
      Value             : valueText,
      Label             : '{i18n>ProposedValue}',
      ![@UI.Importance] : #High
    },
    {
      Value             : displayStatus,
      Label             : '{i18n>DecisionStatus}',
      Criticality       : status.criticality,
      ![@UI.Importance] : #High
    },
    {
      Value             : proposedBy,
      ![@UI.Importance] : #Medium
    },
    {
      Value             : proposedAt,
      ![@UI.Importance] : #Low
    },
    {
      Value             : effectiveFrom,
      ![@UI.Importance] : #Medium
    },
    {
      Value             : reviewDue,
      Label             : '{i18n>ReviewDue}',
      ![@UI.Importance] : #Medium
    }
  ],
  UI.HeaderFacets       : [{
    $Type : 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#DecisionState'
  }],
  UI.FieldGroup #DecisionState: {Data: [
    {
      Value      : displayStatus,
      Label      : '{i18n>DecisionStatus}',
      Criticality: status.criticality
    },
    {Value: approvalNote, Label: '{i18n>ApprovalNote}'},
    {Value: reviewStateText, Label: '{i18n>DecisionReviewState}'},
    {Value: kindText, Label: '{i18n>DecisionKind}'},
    {Value: camp_ID}
  ]},
  UI.Facets             : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Decision}',
      Target: '@UI.FieldGroup#Proposal'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Workflow',
      Target: '@UI.FieldGroup#Workflow'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>AffectedRequests}',
      Target: 'affectedRequests/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>DecisionReviews}',
      Target: 'reviews/@UI.LineItem'
    }
  ],
  UI.FieldGroup #Proposal: {Data: [
    {Value: standard_code},
    {Value: kindText, Label: '{i18n>DecisionKind}'},
    {Value: valueText, Label: '{i18n>ProposedValue}'},
    {Value: previousText, Label: '{i18n>PreviousValue}'},
    {Value: referenceText, Label: '{i18n>ReferenceFigure}'},
    {Value: reason},
    {Value: source},
    {Value: effectiveFrom},
    {Value: reviewDate},
    {Value: reviewDue, Label: '{i18n>ReviewDue}'}
  ]},
  UI.FieldGroup #Workflow: {Data: [
    {Value: proposedBy},
    {Value: proposedAt},
    {Value: approvedBy},
    {Value: approvedAt},
    {Value: inForceFrom},
    {Value: rejectedBy},
    {Value: rejectedAt},
    {Value: rejectionReason},
    {Value: endedAt},
    {Value: version}
  ]},
  UI.Identification     : [
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.submit', Label: '{i18n>SubmitDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.reviseDraft', Label: '{i18n>ReviseDraft}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.reviseTargetDraft', Label: '{i18n>ReviseTargetDraft}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.revisePhaseDraft', Label: '{i18n>RevisePhaseDraft}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.approve', Label: '{i18n>ApproveDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.rejectProposal', Label: '{i18n>RejectDecision}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.withdrawProposal', Label: '{i18n>WithdrawProposal}'},
    {$Type: 'UI.DataFieldForAction', Action: 'ReliefService.completeReview', Label: '{i18n>CompleteReview}'}
  ]
);

// Assessment history: read-only, exactly as recorded when it was calculated.
annotate service.AssessmentRecords with @(
  UI.HeaderInfo         : {
    TypeName      : '{i18n>AssessmentRecord}',
    TypeNamePlural: '{i18n>AssessmentHistory}',
    Title         : {Value: triggerText},
    Description   : {Value: campName}
  },
  UI.PresentationVariant: {
    SortOrder     : [{Property: assessedAt, Descending: true}],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem           : [
    {Value: assessedAt, ![@UI.Importance]: #High},
    {Value: triggerText, ![@UI.Importance]: #High},
    {Value: actor, ![@UI.Importance]: #High},
    {Value: headcount, ![@UI.Importance]: #Medium},
    {Value: settingsVersion, ![@UI.Importance]: #Low},
    {Value: label, ![@UI.Importance]: #Low}
  ],
  UI.HeaderFacets       : [{$Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#RecordState'}],
  UI.FieldGroup #RecordState: {Data: [
    {Value: assessedAt},
    {Value: actor},
    {Value: headcount},
    {Value: recordedHouseholds},
    {Value: estimatedHouseholds},
    {Value: label}
  ]},
  UI.Facets             : [
    {$Type: 'UI.ReferenceFacet', Label: '{i18n>AssessmentLines}', Target: 'lines/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', Label: '{i18n>AssessmentSettings}', Target: '@UI.FieldGroup#RecordSettings'}
  ],
  UI.FieldGroup #RecordSettings: {Data: [
    {Value: settingsVersion},
    {Value: criticalDays},
    {Value: warningDays},
    {Value: criticalPercent},
    {Value: warningPercent},
    {Value: targetDays},
    {Value: householdSize},
    {Value: householdAssumptionVersion},
    {Value: rationKcalPerPack},
    {Value: rationKcalBasis}
  ]}
);

annotate service.AssessmentRecordLines with @(UI.LineItem: [
  {Value: standardName, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '13rem'}},
  {Value: stateText, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '12rem'}},
  {Value: quantity, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '9rem'}},
  {Value: functionalUnits, ![@UI.Importance]: #Low},
  {Value: requirement, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '9rem'}},
  {Value: perPerson, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '10rem'}},
  {Value: requirementBasisText, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '9rem'}},
  {Value: referencePerPerson, ![@UI.Importance]: #High, ![@HTML5.CssDefaults]: {width: '10rem'}},
  {Value: perHousehold, ![@UI.Importance]: #Low},
  {Value: kcalPerUnit, ![@UI.Importance]: #Low},
  {Value: shortfall, ![@UI.Importance]: #Medium},
  {Value: targetSource, ![@UI.Importance]: #Medium},
  {Value: targetDecisionVersion, ![@UI.Importance]: #Low}
]);

annotate service.DecisionReviews with @(UI.LineItem: [
  {Value: reviewedAt},
  {Value: reviewedBy},
  {Value: outcome_code},
  {Value: explanation},
  {Value: nextReviewDate},
  {Value: decisionVersion}
]);

// What the signed-in user may do; the backend checks it again on every action.
annotate service.CampDecisions actions {
  submit @Core.OperationAvailable: {$edmJson: {$Path: 'in/canSubmit'}};
  reviseDraft @Core.OperationAvailable: {$edmJson: {$Path: 'in/canRevise'}};
  reviseTargetDraft @Core.OperationAvailable: {$edmJson: {$Path: 'in/canReviseTarget'}};
  revisePhaseDraft @Core.OperationAvailable: {$edmJson: {$Path: 'in/canRevisePhase'}};
  completeReview @Core.OperationAvailable: {$edmJson: {$Path: 'in/canReview'}};
  withdrawProposal @Core.OperationAvailable: {$edmJson: {$Path: 'in/canWithdraw'}} @Common.IsActionCritical;
  approve @Core.OperationAvailable: {$edmJson: {$Path: 'in/canApprove'}} @Common.IsActionCritical;
  rejectProposal @Core.OperationAvailable: {$edmJson: {$Path: 'in/canReject'}};
};

// The version the user saw is sent with every action, so a stale action is refused.
annotate service.CampDecisions actions {
  submit(version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden);
  withdrawProposal(version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden);
  approve(version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden);
  rejectProposal(version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden);
  completeReview(version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden);
  revisePhaseDraft(
    version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden,
    responsePhase @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/responsePhase'}},
    reason @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reason'}},
    source @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/source'}},
    reviewDate @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reviewDate'}},
    effectiveFrom @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/effectiveFrom'}}
  );
  reviseTargetDraft(
    version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden,
    targetPerPerson @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/targetPerPerson'}},
    reason @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reason'}},
    source @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/source'}},
    reviewDate @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reviewDate'}},
    effectiveFrom @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/effectiveFrom'}}
  );
  reviseDraft(
    version @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/version'}} @UI.Hidden,
    reason @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reason'}},
    source @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/source'}},
    reviewDate @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/reviewDate'}},
    effectiveFrom @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/effectiveFrom'}}
  );
};

annotate service.Pledges with @(UI.LineItem: [
  {
    $Type : 'UI.DataFieldForAction',
    Action: 'ReliefService.confirmDelivery',
    Label : '{i18n>RecordReceivedQuantity}'
  },
  {
    $Type : 'UI.DataFieldForAction',
    Action: 'ReliefService.closePledge',
    Label : '{i18n>ClosePledge}'
  },
  {
    $Type : 'UI.DataFieldForAction',
    Action: 'ReliefService.withdraw',
    Label : '{i18n>Withdraw}'
  },
  {
    $Type : 'UI.DataFieldForAction',
    Action: 'ReliefService.withdrawAllOfDonor',
    Label : '{i18n>WithdrawAllOfDonor}'
  },
  {Value: donor},
  {Value: donorContact},
  {Value: quantity},
  {Value: receivedQuantity},
  {Value: acceptedQuantity},
  {Value: eta},
  {
    Value      : status_code,
    Criticality: status.criticality
  },
  {Value: closeReason}
]);

annotate service.Pledges actions {
  // ARCH-03: goods can arrive in several shipments until the pledge is complete
  confirmDelivery @Core.OperationAvailable: {$edmJson: {$Or: [{$Eq: [{$Path: 'in/status_code'}, 'PLEDGED']}, {$Eq: [{$Path: 'in/status_code'}, 'PARTIAL']}]}};
  closePledge @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'PARTIAL']}};
  withdraw @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'PLEDGED']}}
           @Common.IsActionCritical;
  withdrawAllOfDonor @Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status_code'}, 'PLEDGED']}}
           @Common.IsActionCritical;
};

// ARCH-03, ARCH-06: every arrival of goods, including late deliveries to a closed camp
annotate service.DeliveryReceipts with @(
  UI.PresentationVariant: {SortOrder: [{Property: receivedAt, Descending: true}], Visualizations: ['@UI.LineItem']},
  UI.LineItem           : [
    {Value: receivedAt, ![@UI.Importance]: #High},
    {Value: request.standard.name, Label: '{i18n>Standard}', ![@UI.Importance]: #High},
    {Value: pledge.donor, Label: '{i18n>Donor}', ![@UI.Importance]: #Medium},
    {Value: receivedQuantity, ![@UI.Importance]: #High},
    {Value: acceptedQuantity, ![@UI.Importance]: #High},
    {Value: conditionText, ![@UI.Importance]: #High},
    {Value: reason, ![@UI.Importance]: #Medium},
    {Value: overReceipt, ![@UI.Importance]: #Medium},
    {Value: afterClosure, ![@UI.Importance]: #Medium},
    {Value: receivedBy, ![@UI.Importance]: #Low}
  ]
);

// ARCH-05: the stock ledger of the camp; each line starts where the previous one ended
annotate service.StockMovements with @(
  UI.PresentationVariant: {SortOrder: [{Property: movedAt, Descending: true}], Visualizations: ['@UI.LineItem']},
  UI.LineItem           : [
    {Value: movedAt, ![@UI.Importance]: #High},
    {Value: stock.standard.name, Label: '{i18n>Standard}', ![@UI.Importance]: #High},
    {Value: kindText, ![@UI.Importance]: #High},
    {Value: quantityBefore, ![@UI.Importance]: #High},
    {Value: change, ![@UI.Importance]: #High},
    {Value: quantityAfter, ![@UI.Importance]: #High},
    {Value: movedBy, ![@UI.Importance]: #Medium},
    {Value: note, ![@UI.Importance]: #Low}
  ]
);

// ARCH-05: who did what in the camp's supply chain
annotate service.AuditEvents with @(
  UI.PresentationVariant: {SortOrder: [{Property: occurredAt, Descending: true}], Visualizations: ['@UI.LineItem']},
  UI.LineItem           : [
    {Value: occurredAt, ![@UI.Importance]: #High},
    {Value: kindText, ![@UI.Importance]: #High},
    {Value: actor, ![@UI.Importance]: #High},
    {Value: detail, ![@UI.Importance]: #High}
  ]
);

// UX-07 with ARCH-04: Delete is offered only for a camp without counts, requests or decisions
annotate service.Camps with @UI.DeleteHidden: {$edmJson: {$Not: {$Path: 'deletable'}}};
