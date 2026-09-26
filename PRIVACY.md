# Privacy

linkward has no server, no account, and no analytics. Nothing it sees leaves
your machine.

## What it looks at

While the feature is switched on, linkward sees the **address of a page that is
about to open in a newly created tab**, and only long enough to decide whether
to ask you about it. It looks at nothing else on the page: no content, no form
data, no cookies, no history.

It needs access to all websites for one reason: it cannot know in advance which
address another application is going to hand over. There is no narrower
permission that would work.

## What it stores

On your machine only:

- whether the feature is on, and your never-ask list — in browser sync storage,
  so they follow you between your own signed-in browsers;
- the container you chose last, and any per-site choices you asked it to
  remember — in **local** storage, because a container id means a different
  container on a different machine.

No list of the links you opened is kept. A choice you asked to be remembered
stores the **host**, not the address.

## What it sends

Nothing over the network. There is no network code in this extension.

It does send one message **on your machine**, to two other add-ons by fixed id:
`container-commander@sapn95.github.io` and `beeline@sapn95.github.io`. The message
is the word `cc:ping` and nothing else. What comes back, and what linkward answers
when one of them asks the same question, is whether it is currently set to reopen
links and which hosts you have pinned to a container — so that either settings
page can tell you when two add-ons are both moving your links and opening two tabs
for every one. No address you visited and no choice you made is in it. A host on
your never-ask list is left out, because linkward does not act on it.

If neither add-on is installed nothing is sent anywhere, and nothing else can ask:
a message from any other id is ignored without a reply.

## Turning it off

Unticking the setting hands the website access back to the browser
(`permissions.remove`), and no listener is registered while it is absent. You
can also revoke it yourself in your browser's own add-on settings; linkward
checks what the browser actually grants rather than what it stored, so the
switch tells you the truth either way.

## Questions

<https://github.com/sapn95/linkward/issues>
