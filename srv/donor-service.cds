using reliefgrid as db from '../db/schema';

/**
 * Public pledge board for NGOs, companies and volunteer groups. Exposes what
 * camps need without coordinator phone numbers or other donors' contacts.
 */
@path    : '/odata/v4/donor'
// SEC-06: donors are a controlled list of known organisations, with the Donor role
@requires: 'Donor'
service DonorService {


  @readonly
  entity Requests      as
    projection on db.Requests {
      ID,
      camp.name           as campName,
      camp.district       as district,
      camp.region         as region,
      camp.hazard         as hazard,
      camp.headcount      as campHeadcount,
      standard,
      standard.sector     as sector,
      standard.unit       as unit,
      quantity,
      pledgedQuantity,
      deliveredQuantity,
      remaining,
      priority,
      status,
      neededBy,
      note,
      createdAt,
      pledges
    }
    where
          status.code      <> 'CANCELLED'
      and camp.status.code =  'ACTIVE'
      // not a pledge opportunity while under review, or while the indicator is not established for the camp
      and (review.code is null or review.code <> 'PENDING')
      and line.assessment not in ('NOT_DECIDED', 'NOT_APPLICABLE', 'NO_REQUIREMENT')
    actions {
      @(Common.SideEffects.TargetEntities: ['in', 'in/pledges'])
      action pledge(
        @(title: '{i18n>Donor}', mandatory)
        donor        : String(120),
        @(title: '{i18n>DonorContact}')
        donorContact : String(120),
        @(title: '{i18n>Quantity}', mandatory)
        quantity     : db.Quantity,
        @(title: '{i18n>Eta}')
        eta          : Date
      ) returns Pledges;
    };

  /**
   * Allow-list on purpose: who created or changed a pledge (user ids, often
   * e-mail addresses) and donor contacts stay with coordinators.
   */
  @readonly
  entity Pledges       as
    projection on db.Pledges {
      ID,
      request,
      donor,
      quantity,
      receivedQuantity,
      acceptedQuantity,
      eta,
      status,
      // UX-14: what was pledged, and where, stays visible when the camp closes or the request is cancelled
      request.camp.name      as campName,
      request.standard.name  as standardName,
      request.standard.unit  as unit,
      situation
    };

  /** The signed-in donor's own pledges, including those whose camp closed or whose request was cancelled (UX-14). */
  @readonly
  @cds.redirection.target: false
  entity MyPledges     as
    projection on db.Pledges {
      ID,
      donor,
      quantity,
      receivedQuantity,
      acceptedQuantity,
      eta,
      status,
      createdAt,
      request.camp.name      as campName,
      request.camp.district  as district,
      request.standard.name  as standardName,
      request.standard.unit  as unit,
      request.status.name    as requestStatus,
      situation
    }
    where createdBy = $user;

  @readonly
  entity Standards     as projection on db.Standards;

  @readonly
  entity Sectors       as projection on db.Sectors;

  @readonly
  entity Hazards       as projection on db.Hazards;

  @readonly
  entity RequestStatus as projection on db.RequestStatus;

  @readonly
  entity PledgeStatus  as projection on db.PledgeStatus;

  @readonly
  entity Priorities    as projection on db.Priorities;
}
