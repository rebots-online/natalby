import { APP_NAME } from '../services/appIdentity';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auth } from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { checkDownloadAccess, type DownloadRequest } from '../services/downloadAccess';
import { getCheckoutOffer, purchaseCheckoutOffer, type CheckoutOffer } from '../services/revenueCatCheckout';
import { reconcileBillingAccess, restoreBillingPurchases } from '../services/billingAccess';
import './PurchaseAccess.css';
import { FigmaPaywall, type OfferPrices, type OfferTerms, type OfferTermsByKind } from './FigmaPaywall';
import { purchaseIntent, type PurchaseIntent, type PurchaseKind } from '../services/purchaseIntent';

type Intent = {
  seq:number; gen:number; kind:PurchaseKind|null;
  request?:DownloadRequest; run?:()=>void|Promise<void>; current:()=>boolean;
  owner:string|null; explicitPurchase:boolean;
};
type AccessContext = {
  requestDownload:(request:DownloadRequest,run:()=>void|Promise<void>,current?:()=>boolean)=>Promise<void>;
  showOffer:(resourceId?:string,selection?:PurchaseIntent)=>void;
  showOffers:()=>void;
};
const Access=createContext<AccessContext|null>(null);
export function usePurchaseAccess() { const value=useContext(Access); if(!value) throw new Error('Purchase access provider is missing'); return value; }

export function PurchaseAccessProvider({children}:{children:React.ReactNode}) {
  const [intent,setIntent]=useState<Intent|null>(null);
  const [prices,setPrices]=useState<OfferPrices>({reading:null,conversation:null});
  const [terms,setTerms]=useState<OfferTermsByKind>({reading:null,conversation:null});
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [checkoutOverlay,setCheckoutOverlay]=useState(false);
  const intentRef=useRef<Intent|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const operation=useRef(0);
  const authGeneration=useRef(0);
  const authUid=useRef<string|null|undefined>(undefined);
  const mounted=useRef(true);
  const purchaseInFlight=useRef(false);
  const paymentConfirmed=useRef(false);
  const storePendingKind=useRef<PurchaseKind|null>(null);
  const launchAttempt=useRef<{seq:number;kind:PurchaseKind}|null>(null);
  const busyRef=useRef(false);
  const quotes=useRef<{reading?:CheckoutOffer;conversation?:CheckoutOffer}>({});
  const quotesOwner=useRef<string|null>(null);
  const termsRef=useRef<OfferTermsByKind>({reading:null,conversation:null});
  const loadSeq=useRef(0);
  const expiryTimer=useRef<number|undefined>(undefined);
  const queuedUrl=useRef<{type:'offer';kind:PurchaseKind}|{type:'journey'}|null>(null);
  const applyIntent=(value:Intent|null)=>{intentRef.current=value;setIntent(value);};
  const setBusyState=(value:boolean)=>{busyRef.current=value;setBusy(value);};
  const valid=(value:Intent|null):value is Intent=>!!value&&mounted.current&&operation.current===value.seq&&authGeneration.current===value.gen&&value.current()&&(auth.currentUser?.uid??null)===value.owner;
  const sessionCurrent=(owner:string,gen?:number)=>mounted.current&&(auth.currentUser?.uid??null)===owner&&(gen===undefined||authGeneration.current===gen);
  const setTermsState=(value:OfferTermsByKind)=>{termsRef.current=value;setTerms(value);};
  const clearQuotes=()=>{quotes.current={};quotesOwner.current=null;setPrices({reading:null,conversation:null});setTermsState({reading:null,conversation:null});};
  const close=()=>{
    operation.current++;
    applyIntent(null);
    clearQuotes();
    paymentConfirmed.current=false;
    setBusyState(false);
    setMessage('');
  };
  const scheduleExpiry=()=>{
    window.clearTimeout(expiryTimer.current);
    const times=[quotes.current.reading?.expiresAt,quotes.current.conversation?.expiresAt].filter((value):value is number=>typeof value==='number');
    if(times.length===0)return;
    const delay=Math.max(0,Math.min(...times)-Date.now());
    expiryTimer.current=window.setTimeout(()=>{
      if(!mounted.current||purchaseInFlight.current)return;
      const current=intentRef.current;
      if(!current||!sessionCurrent(current.owner??'')||quotesOwner.current!==(auth.currentUser?.uid??null))return;
      let changed=false;
      const next:OfferPrices={reading:null,conversation:null};
      const nextTerms:OfferTermsByKind={reading:null,conversation:null};
      for(const kind of ['reading','conversation'] as const){
        const quote=quotes.current[kind];
        if(quote&&Date.now()>=quote.expiresAt){changed=true;next[kind]=null;nextTerms[kind]=null;}
        else if(quote){next[kind]=quote.formattedPrice;nextTerms[kind]=offerTerms(quote);}
      }
      if(changed){setPrices(next);setTermsState(nextTerms);void loadQuotes(current,false);}
    },delay);
  };
  const offerTerms=(offer:CheckoutOffer):OfferTerms|null=>{
    const raw=offer as Partial<OfferTerms>;
    const productType=raw.productType;
    if(productType!=='subscription'&&productType!=='one_time')return null;
    const billingPeriod=productType==='one_time'||typeof raw.billingPeriod!=='string'
      ?null
      :raw.billingPeriod;
    return {productType,billingPeriod,productTitle:typeof raw.productTitle==='string'?raw.productTitle:''};
  };
  const loadQuotes=async(value:Intent,allowLaunch=true)=>{
    const owner=value.owner;
    if(!owner||purchaseInFlight.current)return;
    const seq=++loadSeq.current;
    setMessage('Checking prices…');
    try{
      const results=await Promise.allSettled([getCheckoutOffer('reading'),getCheckoutOffer('conversation')]);
      if(!mounted.current||!valid(value)||seq!==loadSeq.current)return;
      const kinds=['reading','conversation'] as const;
      const next:OfferPrices={reading:null,conversation:null};
      const nextTerms:OfferTermsByKind={reading:null,conversation:null};
      let loaded=false;
      for(let index=0;index<kinds.length;index++){
        const result=results[index];
        if(result.status==='fulfilled'&&result.value.ownerUid===owner){
          const offer=result.value;
          quotes.current[kinds[index]]=offer;
          quotesOwner.current=owner;
          const expired=Date.now()>=offer.expiresAt;
          next[kinds[index]]=expired?null:offer.formattedPrice;
          nextTerms[kinds[index]]=expired?null:offerTerms(offer);
          loaded=true;
        }else{
          quotes.current[kinds[index]]=undefined;
        }
      }
      if(!loaded)throw new Error('The offers could not be loaded. Please try again.');
      setPrices(next);
      setTermsState(nextTerms);
      setMessage(kinds.some(kind=>!quotes.current[kind])?'Some prices could not be loaded. Please try again later.':'');
      scheduleExpiry();
      const kind=value.kind;
      if(allowLaunch&&kind&&value.explicitPurchase&&!paymentConfirmed.current&&!busyRef.current&&!purchaseInFlight.current
        &&(!launchAttempt.current||launchAttempt.current.seq!==value.seq||launchAttempt.current.kind!==kind)){
        launchAttempt.current={seq:value.seq,kind};
        void startPurchase(value,kind);
      }
    }catch(error){
      if(!mounted.current||!valid(value)||seq!==loadSeq.current)return;
      clearQuotes();
      setMessage(error instanceof Error&&error.message?error.message:'The offers could not be loaded. Please try again.');
    }
  };
  const finishAfterAccess=async(value:Intent,ready:boolean)=>{
    const owner=value.owner;
    if(!owner)return;
    if(value.run&&value.request){
      const access=await checkDownloadAccess(value.request);
      if(!valid(value)||!sessionCurrent(owner,value.gen))return;
      if(access.state==='owned'){if(valid(value)){close();await value.run();}return;}
      if(valid(value))setMessage(access.state==='unavailable'?access.message:access.title);
      return;
    }
    if(ready&&valid(value))close();
  };
  const startPurchase=async(value:Intent,kind:PurchaseKind)=>{
    const owner=value.owner;
    if(purchaseInFlight.current||busyRef.current)return;
    const offer=quotes.current[kind];
    const kindTerms=termsRef.current[kind];
    if(!owner||!offer||offer.ownerUid!==owner||!kindTerms||!valid(value)||paymentConfirmed.current)return;
    if(kindTerms.productType==='subscription'&&!kindTerms.billingPeriod){
      setMessage('Recurring billing details for this offer are unavailable right now. Please try again later.');
      return;
    }
    if(storePendingKind.current===kind&&!paymentConfirmed.current){
      setMessage('Your purchase is pending in the store and has not been confirmed yet. Do not buy again; use restore below to check your access.');
      return;
    }
    if(Date.now()>=offer.expiresAt){
      setPrices(prev=>({...prev,[kind]:null}));
      void loadQuotes(value,false);
      return;
    }
    purchaseInFlight.current=true;
    setBusyState(true);
    setMessage('Opening secure checkout…');
    setCheckoutOverlay(true);
    let refresh=false;
    try{
      const outcome=await purchaseCheckoutOffer(offer);
      if(!mounted.current)return;
      if(!sessionCurrent(owner,value.gen))return;
      if(outcome.state==='cancelled'){
        refresh=true;
        if(valid(value))setMessage('');
        return;
      }
      if(outcome.state==='pending'){
        storePendingKind.current=kind;
        if(valid(value))setMessage('Your purchase is pending in the store and has not been confirmed yet. Do not buy again; use restore below to check your access.');
        return;
      }
      paymentConfirmed.current=true;
      if(storePendingKind.current===kind)storePendingKind.current=null;
      if(valid(value)){
        setPrices(prev=>({...prev,[kind]:null}));
        setTermsState({...termsRef.current,[kind]:null});
        setMessage('Payment confirmed. Preparing your access…');
      }
      const access=await reconcileBillingAccess(owner,false,()=>sessionCurrent(owner,value.gen));
      if(!mounted.current||!sessionCurrent(owner,value.gen))return;
      window.dispatchEvent(new CustomEvent('natally:purchase-access-changed',{detail:{kind}}));
      const ready=access.state==='ready'&&!!access.connected;
      if(valid(value))setMessage(access.state==='ready'
        ?access.message
        :access.state==='pending'
          ?'Your purchase is confirmed and access is still being prepared. Do not buy again; use restore below to check again.'
          :'Payment confirmed. Reading access could not be connected yet. Do not buy again; use restore below to check again.');
      await finishAfterAccess(value,ready);
      return;
    }catch(error){
      if(mounted.current&&sessionCurrent(owner,value.gen)){
        if(paymentConfirmed.current){
          if(valid(value))setMessage('Your purchase is confirmed. Use restore below to check your access; do not buy again.');
        }else{
          refresh=true;
          if(valid(value))setMessage(error instanceof Error&&error.message?error.message:'The checkout could not be completed. Please try again.');
        }
      }
    }finally{
      purchaseInFlight.current=false;
      if(mounted.current&&operation.current===value.seq&&authGeneration.current===value.gen){
        setBusyState(false);
        setCheckoutOverlay(false);
      }
      if(refresh&&valid(value)&&!paymentConfirmed.current)void loadQuotes(value,false);
    }
  };
  const restore=async(value:Intent)=>{
    const owner=value.owner;
    if(!owner||purchaseInFlight.current||busyRef.current||!valid(value))return;
    setBusyState(true);
    setMessage(paymentConfirmed.current?'Checking your access again…':'Restoring purchases…');
    try{
      const access=await restoreBillingPurchases(owner,()=>sessionCurrent(owner,value.gen));
      if(!mounted.current||!sessionCurrent(owner,value.gen))return;
      const ready=access.state==='ready'&&!!access.connected;
      if(access.state==='ready'){
        window.dispatchEvent(new CustomEvent('natally:purchase-access-changed',{detail:{kind:value.kind??'reading'}}));
        if(valid(value))setMessage(access.message);
        await finishAfterAccess(value,ready);
        return;
      }
      if(valid(value))setMessage(access.state==='pending'
        ?'Your purchase is confirmed and access is still being prepared. Do not buy again; use restore below to check again.'
        :access.message||'Your store purchase status could not be confirmed. Reading access is not connected yet.');
      await finishAfterAccess(value,ready);
    }catch(error){
      if(valid(value))setMessage(error instanceof Error&&error.message?error.message:'Restoring could not be completed. Please try again.');
    }finally{
      if(mounted.current&&operation.current===value.seq&&authGeneration.current===value.gen)setBusyState(false);
    }
  };
  const resumeDownload=async(value:Intent)=>{
    if(!value.run||!value.request)return;
    setBusyState(false);
    setMessage('Checking your purchase…');
    try{
      const access=await checkDownloadAccess(value.request);
      if(!valid(value))return;
      if(access.state==='owned'){close();await value.run();return;}
      setMessage(access.state==='unavailable'?access.message:access.title);
      void loadQuotes(value,false);
    }catch(error){
      if(valid(value))setMessage(error instanceof Error&&error.message?error.message:'Your purchase could not be checked. Please try again.');
    }
  };
  const requestDownload=async(request:DownloadRequest,run:()=>void|Promise<void>,current=()=>true)=>{
    if(purchaseInFlight.current)return;
    const owner=auth.currentUser?.uid??null;
    const value:Intent={seq:++operation.current,gen:authGeneration.current,kind:request.purchaseIntent?.kind??'reading',request,run,current,owner,explicitPurchase:false};
    paymentConfirmed.current=false;
    clearQuotes();
    applyIntent(value);
    if(!owner||!current()){setMessage('Sign in to check your purchase. Your reading stays here.');return;}
    await resumeDownload(value);
  };
  const showOffer=(resourceId='natal-reading',selection=purchaseIntent('reading','reading-entry'))=>{
    if(purchaseInFlight.current)return;
    const owner=auth.currentUser?.uid??null;
    const value:Intent={seq:++operation.current,gen:authGeneration.current,kind:selection.kind,request:{format:'pdf',resourceId,purchaseIntent:selection},current:()=>true,owner,explicitPurchase:true};
    paymentConfirmed.current=false;
    clearQuotes();
    applyIntent(value);
    if(!owner){setMessage('Sign in to continue your purchase.');return;}
    void loadQuotes(value);
  };
  const showOffers=()=>{
    if(purchaseInFlight.current)return;
    const owner=auth.currentUser?.uid??null;
    const value:Intent={seq:++operation.current,gen:authGeneration.current,kind:null,current:()=>true,owner,explicitPurchase:false};
    paymentConfirmed.current=false;
    clearQuotes();
    applyIntent(value);
    if(!owner){setMessage('Sign in to see the offers.');return;}
    void loadQuotes(value,false);
  };
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;window.clearTimeout(expiryTimer.current);};
  },[]);
  useEffect(()=>{
    const url=new URL(window.location.href);
    const offerParam=url.searchParams.get('offer');
    const offersParam=url.searchParams.get('offers');
    if(offerParam==='reading'||offerParam==='conversation'){
      url.searchParams.delete('offer');
      queuedUrl.current={type:'offer',kind:offerParam};
    }else if(offersParam==='1'){
      url.searchParams.delete('offers');
      queuedUrl.current={type:'journey'};
    }
    if(queuedUrl.current)window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);
    const unsubscribe=onAuthStateChanged(auth,user=>{
      if(!mounted.current)return;
      const uid=user?.uid??null;
      if(authUid.current===uid)return;
      authUid.current=uid;
      authGeneration.current+=1;
      storePendingKind.current=null;
      const queued=queuedUrl.current;
      if(uid&&queued){
        queuedUrl.current=null;
        if(queued.type==='offer')showOffer(queued.kind==='reading'?'natal-reading':'conversation',purchaseIntent(queued.kind,'url-offer'));
        else showOffers();
        return;
      }
      const current=intentRef.current;
      if(!current)return;
      if(current.owner===null&&uid&&!purchaseInFlight.current){
        const value:Intent={...current,seq:++operation.current,gen:authGeneration.current,owner:uid};
        applyIntent(value);
        if(value.run&&value.request)void resumeDownload(value);
        else void loadQuotes(value,value.explicitPurchase);
        return;
      }
      if(current.owner!==null&&current.owner!==uid)close();
    });
    const onShowOffers=()=>showOffers();
    window.addEventListener('natally:show-offers',onShowOffers);
    return()=>{unsubscribe();window.removeEventListener('natally:show-offers',onShowOffers);};
  },[]);
  const dialogPresent=!!intent&&intent.owner!==null;
  useEffect(()=>{
    const element=dialog.current;
    if(!element)return;
    if(dialogPresent&&!checkoutOverlay){if(!element.open)element.showModal();}
    else if(element.open)element.close();
  },[dialogPresent,checkoutOverlay]);
  return <Access.Provider value={{requestDownload,showOffer,showOffers}}>{children}
    {intent&&dialogPresent&&intent.owner&&createPortal(
      <dialog ref={dialog} className="natally-offer natally-offer--original" aria-label={`${APP_NAME} reading purchase options`}
        onCancel={event=>{event.preventDefault();close();}}>
        <FigmaPaywall ownerUid={intent.owner} isCurrent={()=>valid(intent)}
          prices={prices} terms={terms} busy={busy} message={message}
          initialScreen={intent.kind==='conversation'?2:1}
          onPurchase={kind=>{const value=intentRef.current;if(value&&!purchaseInFlight.current)void startPurchase(value,kind);}}
          onRestore={()=>{const value=intentRef.current;if(value)void restore(value);}}
          onClose={close} />
      </dialog>,document.body)}
  </Access.Provider>;
}

export function PurchaseCTA({kind,sourceSection,children,onOpen}:{kind:PurchaseKind;sourceSection:string;children:React.ReactNode;onOpen?:()=>void}) {
  const {showOffer}=usePurchaseAccess();
  return <button type="button" className="natally-purchase-cta" data-purchase-section={sourceSection} data-purchase-kind={kind}
    onClick={()=>{onOpen?.();showOffer(kind==='reading'?'natal-reading':'conversation',purchaseIntent(kind,sourceSection));}}>{children}</button>;
}
export function ReadingPurchaseNotice(){return <aside className="reading-purchase-notice"><span>Conversations use prepaid access. Reading bundles include the files listed in your offer.</span><PurchaseCTA kind="reading" sourceSection="reading-notice">Buy my reading</PurchaseCTA></aside>;}
