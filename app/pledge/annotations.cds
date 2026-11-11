using DonorService as service from '../../srv/donor-service';

annotate service.Requests with @(
  UI.HeaderInfo          : {
    TypeName      : 'Need',
    TypeNamePlural: 'Open Needs',
    TypeImageUrl  : 'sap-icon://heart',
    Title         : {Value: standard_code},
    Description   : {Value: campName}
  },
  UI.SelectionFields     : [
    region,
    district,
    sector_code,
    standard_code,
    hazard_code,
    priority_code
  ],
  UI.PresentationVariant : {
    SortOrder     : [
      {Property: priority_code},
      {Property: neededBy}
    ],
    Visualizations: ['@UI.LineItem']
  },
  // two tabs: what camps still need, and the donor's own pledges (UX-14)
  UI.SelectionPresentationVariant #Needs: {
    Text               : '{i18n>OpenNeedsTab}',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: ![@UI.PresentationVariant]
  },
  UI.LineItem            : [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'DonorService.pledge',
      Label : '{i18n>PledgeAction}'
    },
    {
      Value                    : priority_code,
      Criticality              : priority_code,
      CriticalityRepresentation: #WithIcon,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '8rem'}
    },
    {
      Value             : standard_code,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '12rem'}
    },
    {
      Value             : remaining,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '10rem'}
    },
    {
      Value             : campName,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '16rem'}
    },
    {
      Value             : district,
      ![@UI.Importance] : #Medium,
      ![@HTML5.CssDefaults]: {width: '11rem'}
    },
    {
      Value             : neededBy,
      ![@UI.Importance]: #High,
      ![@HTML5.CssDefaults]: {width: '9rem'}
    },
    {
      Value             : status_code,
      Criticality       : status.criticality,
      ![@UI.Importance] : #High,
      ![@HTML5.CssDefaults]: {width: '11rem'}
    }
  ],
  UI.DataPoint #Progress : {
    Value        : pledgedQuantity,
    TargetValue  : quantity,
    Visualization: #Progress
  },
  UI.DataPoint #Remaining: {
    Value      : remaining,
    Title      : '{i18n>Remaining}',
    Criticality: priority_code
  },
  UI.DataPoint #People   : {
    Value: campHeadcount,
    Title: 'People at Camp'
  },
  UI.HeaderFacets        : [
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Remaining'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#Progress'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#People'
    }
  ],
  UI.Identification      : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'DonorService.pledge',
    Label : '{i18n>PledgeAction}'
  }],
  UI.Facets              : [
    {
      $Type : 'UI.CollectionFacet',
      ID    : 'Need',
      Label : 'What Is Needed',
      Facets: [
        {
          $Type : 'UI.ReferenceFacet',
          Label : 'Supply',
          Target: '@UI.FieldGroup#Supply'
        },
        {
          $Type : 'UI.ReferenceFacet',
          Label : 'Destination',
          Target: '@UI.FieldGroup#Camp'
        }
      ]
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Pledges So Far',
      Target: 'pledges/@UI.LineItem'
    }
  ],
  UI.FieldGroup #Supply  : {Data: [
    {Value: standard_code},
    {Value: sector_code},
    {Value: quantity},
    {Value: pledgedQuantity},
    {Value: deliveredQuantity},
    {Value: neededBy},
    {
      Value      : priority_code,
      Criticality: priority_code
    },
    {Value: note}
  ]},
  UI.FieldGroup #Camp    : {Data: [
    {Value: campName},
    {Value: district},
    {Value: region},
    {Value: hazard_code},
    {Value: campHeadcount}
  ]}
) {
  campName      @title: '{i18n>Camp}';
  district      @title: '{i18n>District}';
  region        @title: '{i18n>Region}';
  campHeadcount @title: '{i18n>Headcount}';
  hazard        @title: '{i18n>Hazard}'  @Common.Text: hazard.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  sector        @title: '{i18n>Sector}'  @Common.Text: sector.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  priority      @title: '{i18n>Priority}'  @Common.Text: priority.name  @Common.TextArrangement: #TextOnly  @Common.ValueListWithFixedValues;
  unit          @UI.Hidden;
};

annotate service.Requests actions {
  pledge @Core.OperationAvailable: {$edmJson: {$Or: [
    {$Eq: [{$Path: 'in/status_code'}, 'OPEN']},
    {$Eq: [{$Path: 'in/status_code'}, 'PARTIAL']}
  ]}};
};

annotate service.Pledges with @(UI.LineItem: [
  {Value: donor},
  {Value: quantity},
  {Value: eta},
  {
    Value      : status_code,
    Criticality: status.criticality
  }
]);

// UX-14: a donor's own pledges stay visible, with what happened to them, after a camp closes or a request is cancelled
annotate service.MyPledges with @(
  UI.SelectionPresentationVariant #Mine: {
    Text               : '{i18n>MyPledgesTab}',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {
      SortOrder     : [{Property: createdAt, Descending: true}],
      Visualizations: ['@UI.LineItem']
    }
  },
  UI.LineItem: [
    {Value: campName, ![@UI.Importance]: #High},
    {Value: district, ![@UI.Importance]: #Medium},
    {Value: standardName, ![@UI.Importance]: #High},
    {Value: quantity, ![@UI.Importance]: #High},
    {Value: receivedQuantity, ![@UI.Importance]: #High},
    {Value: eta, ![@UI.Importance]: #Medium},
    {Value: status_code, Criticality: status.criticality, ![@UI.Importance]: #High},
    {Value: situation, ![@UI.Importance]: #High},
    {Value: donor, ![@UI.Importance]: #Low}
  ]
) {
  campName         @title: '{i18n>Camp}';
  district         @title: '{i18n>District}';
  standardName     @title: '{i18n>Standard}';
  quantity         @title: '{i18n>PledgedQuantity}' @Measures.Unit: unit;
  receivedQuantity @title: '{i18n>ReceivedQuantity}' @Measures.Unit: unit;
  acceptedQuantity @title: '{i18n>AcceptedQuantity}' @Measures.Unit: unit;
  eta              @title: '{i18n>Eta}';
  status           @title: '{i18n>Status}' @Common.Text: status.name @Common.TextArrangement: #TextOnly;
  situation        @title: '{i18n>PledgeSituation}';
  donor            @title: '{i18n>Donor}';
  requestStatus    @title: '{i18n>RequestStatus}';
  createdAt        @title: '{i18n>PledgedOn}';
  unit             @UI.Hidden;
  ID               @UI.Hidden;
};

// UX-11: the pledge dialog starts at what is still needed, in the request's unit, and says what a pledge is
annotate service.Requests actions {
  pledge(
    quantity @UI.ParameterDefaultValue: {$edmJson: {$Path: 'in/remaining'}}
             @title: '{i18n>PledgeQuantity}'
             @Common.QuickInfo: '{i18n>PledgeQuantityInfo}',
    eta      @title: '{i18n>PledgeEta}'
             @Common.QuickInfo: '{i18n>PledgeEtaInfo}',
    donor    @Common.QuickInfo: '{i18n>PledgeDonorInfo}'
  );
};
