@RestResource(urlMapping='/accounts/*')
global with sharing class AccountResource {

    @HttpGet
    global static Account doGet() {
        RestRequest req = RestContext.request;
        String accountId = req.requestURI.substring(req.requestURI.lastIndexOf('/') + 1);
        return [SELECT Id, Name FROM Account WHERE Id = :accountId];
    }

    @HttpPut
    global static String doPut(String name) {
        RestRequest req = RestContext.request;
        String accountId = req.requestURI.substring(req.requestURI.lastIndexOf('/') + 1);
        Account acct = new Account(Id = accountId, Name = name);
        update acct;
        return acct.Id;
    }

    @HttpPatch
    global static void doPatch(String name) {
        // partial update
    }
}
