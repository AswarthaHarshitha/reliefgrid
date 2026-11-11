/**
 * Which applications the signed-in user may open, for the launchpad (display
 * only: every service checks every permission itself). Answers every signed-in
 * user, so the launchpad never has to provoke a refusal to find out.
 */
@path    : '/odata/v4/access'
@requires: 'authenticated-user'
service AccessService {
  type Access {
    planner       : Boolean;
    administrator : Boolean;
    donor         : Boolean;
  }
  function access() returns Access;
}
